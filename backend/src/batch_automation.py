import asyncio
import os
import subprocess
import logging
from pathlib import Path
from datetime import datetime, timezone
from sqlalchemy import select

from src.database import AsyncSessionLocal
from src.models import ClippingCampaign, GeneratedClip, Task as TaskModel, Source as SourceModel
from src.services.secret_service import SecretService
from src.services.instagram_service import InstagramService
from src.ai import generate_campaign_caption_with_hermes, get_most_relevant_parts_by_transcript
from src.video_utils import parse_timestamp_to_seconds
from src.ass_generator import generate_ass_content
from src.ass_renderer import burn_ass_subtitles
from src.config import Config
import whisper

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)
config = Config()

async def run_batch_automation_5_clips(campaign_id: str = "dbef954a-0ff7-4ff6-aede-0075d371907a"):
    async with AsyncSessionLocal() as session:
        res = await session.execute(select(ClippingCampaign).where(ClippingCampaign.id == campaign_id))
        campaign = res.scalar_one_or_none()
        if not campaign:
            print(f"Campaign {campaign_id} not found!")
            return

        print(f"=== LAUNCHING 5-CLIP BATCH AUTOMATION FOR '{campaign.campaign_name}' ===", flush=True)
        print(f"Instagram Target: @{campaign.instagram_username}", flush=True)
        print(f"Mandatory Handles: {campaign.mandatory_tags}", flush=True)

        secret_service = SecretService()
        password_or_sessionid = secret_service.decrypt(campaign.instagram_password_encrypted) if campaign.instagram_password_encrypted else None

        # Video sources already downloaded in /app/
        video_files = [Path("/app/HrX9O6QdXVE.mp4"), Path("/app/pUL3VKiyVm4.mp4"), Path("/app/6PBPIEKvofQ.mp4")]
        valid_files = [f for f in video_files if f.exists()]
        print(f"Found {len(valid_files)} video source files ready for processing.", flush=True)

        clips_dir = Path(config.temp_dir) / "clips"
        clips_dir.mkdir(parents=True, exist_ok=True)

        model = whisper.load_model("tiny", device="cpu")
        published_clips_count = 0

        for video_path in valid_files:
            if published_clips_count >= 5:
                break

            print(f"\n--- Processing Video: {video_path.name} ---", flush=True)
            audio_path = f"/tmp/{video_path.stem}_audio.wav"
            subprocess.run(["ffmpeg", "-y", "-i", str(video_path), "-vn", "-ac", "1", "-ar", "16000", audio_path], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

            res = model.transcribe(audio_path)
            full_text = res["text"]
            segments = res["segments"]
            words = []
            for s in segments:
                seg_words = s["text"].strip().split()
                seg_dur = max(0.1, s["end"] - s["start"])
                w_dur = seg_dur / max(1, len(seg_words))
                for idx, w in enumerate(seg_words):
                    words.append({"text": w, "start": s["start"] + (idx * w_dur), "end": s["start"] + ((idx + 1) * w_dur)})

            # Ask AI for 2-3 clips per video to reach 5 total
            needed = 5 - published_clips_count
            clips_to_get = min(3, needed)
            ai_res = await get_most_relevant_parts_by_transcript(full_text, clips_count=clips_to_get)

            for idx, ai_clip in enumerate(ai_res.most_relevant_segments):
                if published_clips_count >= 5:
                    break

                clip_start = parse_timestamp_to_seconds(ai_clip.start_time)
                clip_end = parse_timestamp_to_seconds(ai_clip.end_time)
                clip_duration = clip_end - clip_start
                clip_text = getattr(ai_clip, "text", "")

                print(f"\n[Clip {published_clips_count + 1}/5] Timestamp: {ai_clip.start_time} -> {ai_clip.end_time} ({clip_duration:.1f}s)", flush=True)
                print(f"Transcript snippet: {clip_text[:100]}...", flush=True)

                # Raw clip extraction
                raw_filename = f"raw_{campaign.id}_{video_path.stem}_{idx}.mp4"
                raw_path = clips_dir / raw_filename
                subprocess.run(["ffmpeg", "-y", "-ss", str(clip_start), "-to", str(clip_end), "-i", str(video_path), "-c:v", "libx264", "-preset", "fast", "-crf", "23", "-c:a", "aac", str(raw_path)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

                # Word timings
                clip_words = []
                for w in words:
                    if w["start"] >= clip_start and w["end"] <= clip_end:
                        clip_words.append({
                            "text": w["text"],
                            "start": round(w["start"] - clip_start, 3),
                            "end": round(w["end"] - clip_start, 3)
                        })

                # Burn subtitles
                subtitle_style = {
                    "font_family": campaign.font_family or "BurbankBigCondensed-Black",
                    "font_size": campaign.font_size or 28,
                    "font_color": campaign.font_color or "#FFFFFF",
                    "highlight_color": campaign.highlight_color or "#FFFF00",
                    "stroke_color": campaign.stroke_color or "#000000",
                    "margin_v_ratio": campaign.margin_v_ratio or 0.42,
                }
                ass_content = generate_ass_content(words=clip_words, subtitle_style=subtitle_style, template=campaign.subtitle_template or "word-focus")
                rendered_filename = f"rendered_{campaign.id}_{video_path.stem}_{idx}.mp4"
                rendered_path = clips_dir / rendered_filename
                burn_ass_subtitles(raw_path, rendered_path, ass_content)

                # Generate Hermes AI Caption
                caption_payload = await generate_campaign_caption_with_hermes(
                    transcript=clip_text or "Chelsea Hirschhorn CEO of Frida sharing key insights.",
                    extracted_rules=campaign.extracted_rules,
                    mandatory_tags=campaign.mandatory_tags,
                    mandatory_hashtags=campaign.mandatory_hashtags,
                    custom_instructions=campaign.caption_instructions
                )
                full_caption = f"{caption_payload.caption}\n\n{' '.join(caption_payload.hashtags)}"
                user_handles = [t.strip() for t in (campaign.mandatory_tags or "").split(",") if t.strip()]

                # Publish to Instagram
                try:
                    media_id = InstagramService.upload_reel(
                        username=campaign.instagram_username,
                        password=password_or_sessionid,
                        video_path=str(rendered_path),
                        caption=full_caption,
                        usertags=user_handles
                    )
                    print(f"🎉 SUCCESS! Clip {published_clips_count + 1} published to Instagram Reel! Media ID: {media_id}", flush=True)

                    # DB Record
                    source = SourceModel(type="youtube", title=video_path.stem, url=str(video_path))
                    session.add(source)
                    await session.flush()

                    task = TaskModel(user_id=campaign.user_id, source_id=source.id, status="completed")
                    session.add(task)
                    await session.flush()

                    db_clip = GeneratedClip(
                        task_id=task.id,
                        campaign_id=campaign.id,
                        filename=rendered_filename,
                        file_path=str(rendered_path),
                        start_time=ai_clip.start_time,
                        end_time=ai_clip.end_time,
                        duration=round(clip_duration, 2),
                        text=clip_text,
                        relevance_score=getattr(ai_clip, "relevance_score", 0.9),
                        clip_order=published_clips_count + 1,
                        instagram_media_id=media_id,
                        published_at=datetime.now(timezone.utc)
                    )
                    session.add(db_clip)
                    await session.commit()
                    published_clips_count += 1
                except Exception as pub_err:
                    print(f"❌ Publishing clip {published_clips_count + 1} failed: {pub_err}", flush=True)

        print(f"\n=================== AUTOMATION COMPLETE ===================", flush=True)
        print(f"Total Clips Published to Instagram @{campaign.instagram_username}: {published_clips_count}/5", flush=True)

if __name__ == "__main__":
    asyncio.run(run_batch_automation_5_clips())
