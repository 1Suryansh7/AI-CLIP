"""
Batch clip generation & Instagram upload for campaign.
Uses the EXACT same pipeline as the review page:
  1. Whisper transcription (with word-level timestamps)
  2. AI viral clip selection via get_most_relevant_parts_by_transcript
  3. create_optimized_clip → burn_ass_subtitles_direct (face-crop + 1080x1920@60fps + ASS subtitles)
  4. Hermes AI caption generation following Google Doc rules
  5. Instagram Reel upload via instagrapi
"""

import asyncio
import json
import sys
from pathlib import Path
from datetime import datetime, timezone

# Add project root to path
sys.path.insert(0, str(Path(__file__).parent.parent))

from src.database import AsyncSessionLocal
from src.models import ClippingCampaign, GeneratedClip, Task as TaskModel, Source as SourceModel
from src.services.secret_service import SecretService
from src.services.instagram_service import InstagramService
from src.ai import get_most_relevant_parts_by_transcript, generate_campaign_caption_with_hermes
from src.video_utils import (
    get_video_transcript,
    parse_timestamp_to_seconds,
    create_clips_from_segments,
    load_cached_transcript_data,
)
from src.utils.async_helpers import run_in_thread
from src.config import Config

config = Config()

CAMPAIGN_ID = "dbef954a-0ff7-4ff6-aede-0075d371907a"
CLIPS_PER_VIDEO = 2  # 2 clips per video × 3 videos = 6 clips total (pick best 5)
TOTAL_CLIPS_TO_UPLOAD = 5

VIDEO_FILES = [
    Path("/app/HrX9O6QdXVE.mp4"),       # 5 min video
    Path("/app/pUL3VKiyVm4.mp4"),        # 36 min podcast
    Path("/app/6PBPIEKvofQ.mp4"),        # 56 min interview
]


async def transcribe_video(video_path: Path) -> dict:
    """Transcribe a video and return transcript data with word timestamps."""
    print(f"\n📝 Transcribing: {video_path.name}...")

    # Check for cached transcript
    cached = load_cached_transcript_data(video_path)
    if cached and cached.get("words"):
        words = cached["words"]
        # Reconstruct full_text from words
        full_text = " ".join(w.get("text", "").strip() for w in words if w.get("text", "").strip())

        # Also try .transcript.txt as backup for better formatted text
        txt_path = video_path.with_suffix(".transcript.txt")
        if txt_path.exists() and not full_text:
            full_text = txt_path.read_text(encoding="utf-8")

        print(f"   ✅ Using cached transcript ({len(words)} words, {len(full_text)} chars)")
        return {"words": words, "full_text": full_text, "segments": []}

    # Fast transcription using whisper tiny on audio
    import subprocess, whisper
    audio_path = f"/tmp/{video_path.stem}_audio.wav"
    print(f"   ⚡ Extracting fast 16kHz mono audio...")
    subprocess.run(["ffmpeg", "-y", "-i", str(video_path), "-vn", "-ac", "1", "-ar", "16000", audio_path], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    
    print(f"   ⚡ Transcribing fast audio with Whisper 'tiny'...")
    model = whisper.load_model("tiny", device="cpu")
    res = model.transcribe(audio_path, word_timestamps=True)
    
    full_text = res.get("text", "")
    words = []
    segments = []
    for s in res.get("segments", []):
        segments.append({"start_time": s["start"], "end_time": s["end"], "text": s["text"]})
        for w in s.get("words", []):
            words.append({"text": w["word"], "start": int(w["start"] * 1000), "end": int(w["end"] * 1000)})
            
    # Cache transcript data for future clip generation
    cache_path = video_path.with_suffix(".transcript_cache.json")
    with open(cache_path, "w") as f:
        json.dump({"words": words, "text": full_text}, f)

    print(f"   ✅ Fast Transcribed: {len(segments)} segments, {len(words)} words")
    return {"words": words, "full_text": full_text, "segments": segments}


async def select_viral_clips(full_text: str, clips_count: int) -> list:
    """Use AI to select the most viral/engaging clip segments."""
    print(f"   🤖 AI selecting {clips_count} best viral clips...")
    ai_result = await get_most_relevant_parts_by_transcript(full_text, clips_count=clips_count)
    segments = []
    for seg in ai_result.most_relevant_segments:
        start = parse_timestamp_to_seconds(seg.start_time)
        end = parse_timestamp_to_seconds(seg.end_time)
        duration = end - start
        text = getattr(seg, "text", "")
        reasoning = getattr(seg, "reasoning", "")
        hook_text = getattr(seg, "hook_text", "")
        print(f"   📌 {seg.start_time} → {seg.end_time} ({duration:.0f}s): {text[:80]}...")
        segments.append({
            "start_time": seg.start_time,
            "end_time": seg.end_time,
            "text": text,
            "relevance_score": getattr(seg, "relevance_score", 0.9),
            "reasoning": reasoning,
            "hook_text": hook_text,
        })
    return segments


async def generate_clips(video_path: Path, segments: list, campaign) -> list:
    """Generate clips using the EXACT same pipeline as the review page."""
    print(f"   🎬 Generating {len(segments)} clips from {video_path.name}...")

    clips_dir = Path(config.temp_dir) / "clips"
    clips_dir.mkdir(parents=True, exist_ok=True)

    # Build subtitle style from campaign settings (same as review page)
    subtitle_style = {
        "font_family": campaign.font_family or "TikTokSans-Regular",
        "font_size": campaign.font_size or 24,
        "font_color": campaign.font_color or "#FFFFFF",
        "highlight_color": campaign.highlight_color or "#FFFF00",
        "stroke_color": campaign.stroke_color or "#000000",
        "margin_v_ratio": campaign.margin_v_ratio or 0.42,
    }
    caption_options = {"subtitle_style": subtitle_style}

    # Use the EXACT same function as the review page
    clips_info = await run_in_thread(
        create_clips_from_segments,
        video_path=video_path,
        segments=segments,
        output_dir=clips_dir,
        use_pycaps=True,
        pycaps_template=campaign.subtitle_template or "word-focus",
        diagnostics={},
        add_subtitles=False,
        caption_options=caption_options,
        target_ratio=9 / 16,
    )

    for clip in clips_info:
        size_mb = Path(clip["path"]).stat().st_size / (1024 * 1024)
        print(f"   ✅ Created: {clip['filename']} ({clip['duration']:.1f}s, {size_mb:.1f}MB)")

    return clips_info


async def upload_to_instagram(clip_path: str, caption: str, username: str, password: str, tags: list) -> str:
    """Upload a reel to Instagram."""
    media_id = await run_in_thread(
        InstagramService.upload_reel,
        username=username,
        password=password,
        video_path=clip_path,
        caption=caption,
        usertags=tags,
    )
    return str(media_id)


async def main():
    print("=" * 60)
    print("🚀 BATCH CLIP GENERATION & INSTAGRAM UPLOAD")
    print("   Using EXACT same pipeline as the Review Page")
    print("=" * 60)

    async with AsyncSessionLocal() as session:
        # 1. Load campaign
        from sqlalchemy import select
        res = await session.execute(
            select(ClippingCampaign).where(ClippingCampaign.id == CAMPAIGN_ID)
        )
        campaign = res.scalar_one()
        secret_service = SecretService()
        password = secret_service.decrypt(campaign.instagram_password_encrypted)
        user_handles = [t.strip() for t in (campaign.mandatory_tags or "").split(",") if t.strip()]

        print(f"\n📋 Campaign: {campaign.campaign_name}")
        print(f"📸 Instagram: @{campaign.instagram_username}")
        print(f"🏷️  Tags: {user_handles}")
        print(f"🎨 Style: template={campaign.subtitle_template}, font={campaign.font_family}, highlight={campaign.highlight_color}")

        # 2. Process each video: transcribe → AI select → generate clips
        all_clips = []

        for video_path in VIDEO_FILES:
            if not video_path.exists():
                print(f"\n⚠️  Video not found: {video_path}")
                continue

            print(f"\n{'─' * 50}")
            print(f"📹 Processing: {video_path.name}")
            print(f"{'─' * 50}")

            # Transcribe
            transcript_data = await transcribe_video(video_path)
            full_text = transcript_data.get("full_text", "")
            if not full_text:
                # Reconstruct from segments
                full_text = " ".join(s.get("text", "") for s in transcript_data.get("segments", []))

            if not full_text:
                print(f"   ❌ No transcript text found, skipping")
                continue

            # AI viral selection
            segments = await select_viral_clips(full_text, CLIPS_PER_VIDEO)

            # Generate clips using review-page pipeline
            clips = await generate_clips(video_path, segments, campaign)
            for clip in clips:
                clip["source_video"] = video_path.name
            all_clips.extend(clips)

        if not all_clips:
            print("\n❌ No clips were generated. Exiting.")
            return

        # 3. Select the best clips (by relevance score)
        all_clips.sort(key=lambda c: c.get("relevance_score", 0), reverse=True)
        clips_to_upload = all_clips[:TOTAL_CLIPS_TO_UPLOAD]

        print(f"\n{'=' * 60}")
        print(f"📤 UPLOADING {len(clips_to_upload)} REELS TO @{campaign.instagram_username}")
        print(f"{'=' * 60}")

        published_count = 0
        for idx, clip_info in enumerate(clips_to_upload, start=1):
            clip_path = clip_info["path"]
            clip_text = clip_info.get("text", "")
            source = clip_info.get("source_video", "unknown")
            size_mb = Path(clip_path).stat().st_size / (1024 * 1024)

            print(f"\n[Reel {idx}/{len(clips_to_upload)}] {clip_info['filename']} from {source} ({size_mb:.1f}MB)")

            # Generate Hermes AI caption with Google Doc rules
            try:
                caption_payload = await generate_campaign_caption_with_hermes(
                    transcript=clip_text,
                    extracted_rules=campaign.extracted_rules,
                    mandatory_tags=campaign.mandatory_tags,
                    mandatory_hashtags=campaign.mandatory_hashtags,
                    custom_instructions=campaign.caption_instructions,
                )
                hashtags_str = " ".join(caption_payload.hashtags)
                full_caption = caption_payload.caption + "\n\n" + hashtags_str
            except Exception as e:
                print(f"   ⚠️  Caption generation failed: {e}")
                full_caption = f"@fridamom Chelsea Hirschhorn dropping CEO insights 🔥\n\n#CEO #Business #Motivation"

            print(f"   📝 Caption: {full_caption[:100]}...")

            # Upload to Instagram
            try:
                media_id = await upload_to_instagram(
                    clip_path=clip_path,
                    caption=full_caption,
                    username=campaign.instagram_username,
                    password=password,
                    tags=user_handles,
                )
                print(f"   🎉 SUCCESS! Media ID: {media_id}")
                published_count += 1

                # Save to DB
                source_obj = SourceModel(type="youtube", title=clip_info["filename"], url=campaign.drive_url)
                session.add(source_obj)
                await session.flush()

                task_obj = TaskModel(user_id=campaign.user_id, source_id=source_obj.id, status="completed")
                session.add(task_obj)
                await session.flush()

                db_clip = GeneratedClip(
                    task_id=task_obj.id,
                    campaign_id=campaign.id,
                    filename=clip_info["filename"],
                    file_path=clip_path,
                    start_time=clip_info["start_time"],
                    end_time=clip_info["end_time"],
                    duration=clip_info["duration"],
                    text=clip_text,
                    relevance_score=clip_info.get("relevance_score", 0.9),
                    clip_order=idx,
                    instagram_media_id=media_id,
                    published_at=datetime.now(timezone.utc),
                )
                session.add(db_clip)
                await session.commit()

            except Exception as e:
                print(f"   ❌ Upload failed: {e}")

        print(f"\n{'=' * 60}")
        print(f"✅ DONE! Published {published_count}/{len(clips_to_upload)} reels to @{campaign.instagram_username}")
        print(f"{'=' * 60}")


if __name__ == "__main__":
    asyncio.run(main())
