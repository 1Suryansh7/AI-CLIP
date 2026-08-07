"""
ASS subtitle burner — burns .ass subtitle content into a video via ffmpeg.

Uses the same ASS content that jassub-worker renders in the browser,
guaranteeing a pixel-perfect match between preview and exported video.
"""

from __future__ import annotations

import logging
import shutil
import subprocess
import tempfile
from pathlib import Path

logger = logging.getLogger(__name__)

# Path to the project's bundled fonts directory so libass can resolve font names.
_FONTS_DIR = Path(__file__).parent.parent / "fonts"


def burn_ass_subtitles(
    input_path: Path,
    output_path: Path,
    ass_content: str,
) -> bool:
    """Burn ASS subtitles into *input_path* and write to *output_path*.

    Args:
        input_path:  Source video file (no subtitles).
        output_path: Destination for the video with burned-in subtitles.
        ass_content: Full ASS file content (string) from ``generate_ass_content()``.

    Returns:
        True on success, False on failure.
    """
    with tempfile.TemporaryDirectory() as tmpdir:
        ass_path = Path(tmpdir) / "subtitles.ass"
        ass_path.write_text(ass_content, encoding="utf-8")

        # Build the ass filter string. We pass fontsdir so libass can
        # resolve font-family names from our bundled TTF files.
        # Also append 1080p scale filter and 60fps frame rate conversion.
        fonts_dir_str = str(_FONTS_DIR).replace("\\", "/").replace(":", "\\:")
        ass_str = str(ass_path).replace("\\", "/").replace(":", "\\:")
        vf_filter = f"ass={ass_str}:fontsdir={fonts_dir_str},scale='if(gte(iw,ih),1920,1080)':'if(gte(iw,ih),1080,1920)':force_original_aspect_ratio=decrease,fps=60"

        cmd = [
            "ffmpeg", "-y",
            "-i", str(input_path),
            "-vf", vf_filter,
            "-r", "60",
            "-c:v", "libx264",
            "-crf", "18",
            "-preset", "fast",
            "-c:a", "copy",
            str(output_path),
        ]

        logger.info("Burning ASS subtitles: %s -> %s", input_path.name, output_path.name)
        result = subprocess.run(cmd, capture_output=True, timeout=300)

        if result.returncode != 0:
            logger.error(
                "ffmpeg ASS burn failed (code %d): %s",
                result.returncode,
                result.stderr.decode(errors="replace")[-2000:],
            )
            return False

        logger.info("ASS subtitles burned successfully: %s", output_path.name)
        return True


def burn_ass_subtitles_direct(
    video_path: Path,
    output_path: Path,
    start_time: float,
    end_time: float,
    crop_x: int,
    crop_y: int,
    crop_w: int,
    crop_h: int,
    ass_content: str,
    pad_color: str = "black",
) -> bool:
    """Fast single-pass clip creation: seeking, crop, 1080p 60fps scaling, and ASS subtitle burn."""
    with tempfile.TemporaryDirectory() as tmpdir:
        ass_path = Path(tmpdir) / "subtitles.ass"
        ass_path.write_text(ass_content, encoding="utf-8")

        fonts_dir_str = str(_FONTS_DIR).replace("\\", "/").replace(":", "\\:")
        ass_str = str(ass_path).replace("\\", "/").replace(":", "\\:")

        # Format pad_color for ffmpeg (e.g. #FFFFFF -> white or 0xFFFFFF)
        clean_pad_color = pad_color.strip()
        if clean_pad_color.startswith("#"):
            clean_pad_color = f"0x{clean_pad_color.lstrip('#')}"

        vf_filter = (
            f"crop={crop_w}:{crop_h}:{crop_x}:{crop_y},"
            f"scale=1080:1920:force_original_aspect_ratio=decrease,"
            f"pad=1080:1920:(1080-iw)/2:(1920-ih)/2:color={clean_pad_color},"
            f"ass={ass_str}:fontsdir={fonts_dir_str},fps=60"
        )

        cmd = [
            "ffmpeg", "-y",
            "-ss", str(start_time),
            "-to", str(end_time),
            "-i", str(video_path),
            "-vf", vf_filter,
            "-r", "60",
            "-c:v", "libx264",
            "-preset", "superfast",
            "-crf", "20",
            "-c:a", "aac",
            "-b:a", "192k",
            str(output_path),
        ]

        logger.info("Single-pass FFmpeg burn: %s (%.1fs - %.1fs) -> %s", video_path.name, start_time, end_time, output_path.name)
        result = subprocess.run(cmd, capture_output=True, timeout=300)

        if result.returncode != 0:
            logger.error(
                "ffmpeg single-pass burn failed (code %d): %s",
                result.returncode,
                result.stderr.decode(errors="replace")[-2000:],
            )
            return False

        logger.info("Single-pass ASS clip burned successfully: %s", output_path.name)
        return True
