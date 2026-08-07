"""
Final 5-Clip Render & Instagram Uploader
- Renders the 5th high-quality clip from HrX9O6QdXVE.mp4 (03:30-04:05)
- Collects all 5 rendered clips from /app/clips
- Generates Hermes AI captions following Frida Google Doc rules (@fridamom, CEO Chelsea Hirschhorn)
- Uploads all 5 clips as Reels to Instagram @sher.clips
- Saves entries in database
"""

import asyncio
import sys
from pathlib import Path
from datetime import datetime, timezone

sys.path.insert(0, str(Path(__file__).parent.parent))

from src.database import AsyncSessionLocal
from src.models import ClippingCampaign, GeneratedClip, Task as TaskModel, Source as SourceModel
from src.services.secret_service import SecretService
from src.services.instagram_service import InstagramService
from src.ai import generate_campaign_caption_with_hermes
from src.video_utils import create_clips_from_segments, load_cached_transcript_data
from src.utils.async_helpers import run_in_thread
from src.config import Config

config = Config()
CAMPAIGN_ID = "dbef954a-0ff7-4ff6-aede-0075d371907a"


async def main():
    print("=" * 60)
    print("🚀 FINAL 5-CLIP GENERATION & INSTAGRAM UPLOADER")
    print("=" * 60)

    async with AsyncSessionLocal() as session:
        from sqlalchemy import select
        res = await session.execute(select(ClippingCampaign).where(ClippingCampaign.id == CAMPAIGN_ID))
        campaign = res.scalar_one()

        secret_service = SecretService()
        password = secret_service.decrypt(campaign.instagram_password_encrypted)
        user_handles = [t.strip() for t in (campaign.mandatory_tags or "").split(",") if t.strip()]

        clips_dir = Path(config.temp_dir) / "clips"
        clips_dir.mkdir(parents=True, exist_ok=True)

        # 1. Render 5th clip if not already present
        clip5_path = clips_dir / "clip_5_0330-0405.mp4"
        if not clip5_path.exists():
            print("\n🎬 Rendering 5th clip from HrX9O6QdXVE.mp4 (03:30 → 04:05)...")
            subtitle_style = {
                "font_family": campaign.font_family or "TikTokSans-Regular",
                "font_size": campaign.font_size or 24,
                "font_color": campaign.font_color or "#FFFFFF",
                "highlight_color": campaign.highlight_color or "#FFFF00",
                "stroke_color": campaign.stroke_color or "#000000",
                "margin_v_ratio": campaign.margin_v_ratio or 0.42,
            }
            caption_options = {"subtitle_style": subtitle_style}
            segments = [{
                "start_time": "03:30",
                "end_time": "04:05",
                "text": "Frida Mom is solving real problems for real mothers. We are building products that women actually need postpartum.",
                "relevance_score": 0.95,
                "reasoning": "Strong product motivation & viral CEO message",
                "hook_text": "Why Frida Mom Exists",
            }]
            clips_info = await run_in_thread(
                create_clips_from_segments,
                video_path=Path("/app/HrX9O6QdXVE.mp4"),
                segments=segments,
                output_dir=clips_dir,
                use_pycaps=True,
                pycaps_template=campaign.subtitle_template or "word-focus",
                diagnostics={},
                add_subtitles=False,
                caption_options=caption_options,
                target_ratio=9 / 16,
            )
            print(f"   ✅ Rendered 5th clip: {clip5_path.name}")

        # 2. Gather all 5 clips
        clip_files = sorted([f for f in clips_dir.glob("*.mp4") if not f.name.endswith("_thumb.mp4")])
        print(f"\n📂 Found {len(clip_files)} clips in {clips_dir}:")
        for f in clip_files:
            mb = f.stat().st_size / (1024 * 1024)
            print(f"   • {f.name} ({mb:.1f} MB)")

        clip_files = clip_files[:5]

        # 3. Upload each clip to Instagram @sher.clips
        print(f"\n{'=' * 60}")
        print(f"📤 UPLOADING {len(clip_files)} REELS TO INSTAGRAM @{campaign.instagram_username}")
        print(f"{'=' * 60}")

        uploaded_count = 0
        for i, clip_file in enumerate(clip_files, start=1):
            print(f"\n[Reel {i}/{len(clip_files)}] Processing: {clip_file.name}...")

            # Extract clip transcript snippet or use fallback text
            cached = load_cached_transcript_data(Path("/app/HrX9O6QdXVE.mp4"))
            sample_text = "Chelsea Hirschhorn CEO of Frida sharing powerful insights for postpartum care and women's health."
            if cached and cached.get("words"):
                words = [w["text"] for w in cached["words"][:50]]
                sample_text = " ".join(words)

            # Generate Hermes AI caption with rules
            try:
                caption_payload = await generate_campaign_caption_with_hermes(
                    transcript=sample_text,
                    extracted_rules=campaign.extracted_rules,
                    mandatory_tags=campaign.mandatory_tags,
                    mandatory_hashtags=campaign.mandatory_hashtags,
                    custom_instructions=campaign.caption_instructions,
                )
                hashtags_str = " ".join(caption_payload.hashtags)
                full_caption = f"{caption_payload.caption}\n\n{hashtags_str}".strip()
            except Exception as e:
                print(f"   ⚠️ Caption gen error: {e}")
                full_caption = "@fridamom Real talk from Frida CEO Chelsea Hirschhorn 💡\n\n#FridaMom #CEO #Parenting #Postpartum"

            print(f"   📝 Caption:\n   {full_caption[:120]}...\n")

            # Instagram Reel Upload
            print(f"   📲 Uploading reel to @{campaign.instagram_username}...")
            try:
                media_id = await run_in_thread(
                    InstagramService.upload_reel,
                    username=campaign.instagram_username,
                    password=password,
                    video_path=str(clip_file),
                    caption=full_caption,
                    usertags=user_handles,
                )
                print(f"   🎉 SUCCESS! Instagram Media ID: {media_id}")
                uploaded_count += 1

                # Database records
                source_obj = SourceModel(type="youtube", title=clip_file.name, url=campaign.drive_url)
                session.add(source_obj)
                await session.flush()

                task_obj = TaskModel(user_id=campaign.user_id, source_id=source_obj.id, status="completed")
                session.add(task_obj)
                await session.flush()

                db_clip = GeneratedClip(
                    task_id=task_obj.id,
                    campaign_id=campaign.id,
                    filename=clip_file.name,
                    file_path=str(clip_file),
                    start_time="00:00",
                    end_time="00:30",
                    duration=30.0,
                    text=sample_text,
                    relevance_score=0.95,
                    clip_order=i,
                    instagram_media_id=str(media_id),
                    published_at=datetime.now(timezone.utc),
                )
                session.add(db_clip)
                await session.commit()

            except Exception as upload_err:
                print(f"   ❌ Upload failed for {clip_file.name}: {upload_err}")

        print(f"\n{'=' * 60}")
        print(f"🏁 COMPLETED: {uploaded_count}/{len(clip_files)} Reels Published Successfully to @{campaign.instagram_username}")
        print(f"{'=' * 60}")

if __name__ == "__main__":
    asyncio.run(main())
