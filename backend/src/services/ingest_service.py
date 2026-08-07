"""
Ingestion service for Whop Clipping Campaigns.
Handles parsing Google Docs requirement links and downloading videos from Google Drive, Dropbox, or YouTube.
"""

import re
import os
import logging
import httpx
from typing import Optional, Dict, Any, List

logger = logging.getLogger(__name__)

class IngestionService:
    @staticmethod
    async def fetch_google_doc_text(url: str) -> str:
        """
        Extracts plain text from a public Google Doc link.
        Works by transforming the doc URL into its text export format.
        """
        doc_id_match = re.search(r"/document/d/([a-zA-Z0-9_-]+)", url)
        if not doc_id_match:
            # If plain text was pasted instead of a URL, return it directly
            return url.strip()

        doc_id = doc_id_match.group(1)
        export_url = f"https://docs.google.com/document/d/{doc_id}/export?format=txt"

        async with httpx.AsyncClient(follow_redirects=True, timeout=30.0) as client:
            response = await client.get(export_url)
            if response.status_code != 200:
                logger.error(f"Failed to fetch Google Doc text: HTTP {response.status_code}")
                raise ValueError(f"Could not access Google Doc. Please make sure link sharing is set to 'Anyone with the link can view'. (HTTP {response.status_code})")
            
            return response.text.strip()

    @staticmethod
    def extract_drive_file_id(url: str) -> Optional[str]:
        """Extract file ID from a Google Drive sharing URL."""
        match = re.search(r"(?:file/d/|id=)([a-zA-Z0-9_-]+)", url)
        return match.group(1) if match else None

    @staticmethod
    def format_dropbox_direct_url(url: str) -> str:
        """Transforms Dropbox share link into direct download URL."""
        if "dropbox.com" in url:
            # Replace dl=0 or www.dropbox.com with direct download url
            url = url.replace("www.dropbox.com", "dl.dropboxusercontent.com")
            url = re.sub(r"[?&]dl=0", "", url)
            if "?" not in url:
                url += "?dl=1"
        return url

    @staticmethod
    def parse_urls_list(raw_input: Optional[str]) -> List[str]:
        """
        Parses multi-line or comma-separated raw text into a clean list of URLs or local file paths.
        """
        if not raw_input:
            return []
        
        raw_parts = re.split(r"[\n,;]+", raw_input)
        urls = []
        for part in raw_parts:
            clean = part.strip()
            if clean and (clean.startswith("http://") or clean.startswith("https://") or "drive.google.com" in clean or "dropbox.com" in clean or "youtube.com" in clean or "youtu.be" in clean or os.path.exists(clean) or clean.endswith((".mp4", ".mkv", ".mov", ".webm", ".avi")) or os.path.isabs(clean)):
                urls.append(clean)
        return urls

    @classmethod
    async def download_video_source(cls, source_url: str, output_dir: str) -> str:
        """
        Downloads video file from YouTube, Google Drive, Dropbox, or returns local file path.
        """
        os.makedirs(output_dir, exist_ok=True)

        # Check if source_url is already a local file path
        if os.path.exists(source_url):
            logger.info(f"Using existing local video file: {source_url}")
            return source_url

        # Check for YouTube URLs first — yt-dlp handles these specially
        if any(domain in source_url for domain in ['youtube.com', 'youtu.be', 'youtube.com/shorts']):
            from ..youtube_utils import download_youtube_video, get_youtube_video_id
            video_id = get_youtube_video_id(source_url)
            if not video_id:
                raise ValueError(f"Could not extract YouTube video ID from URL: {source_url}")

            # Check for cached download
            for ext in ['.mp4', '.mkv', '.webm']:
                cached = os.path.join(output_dir, f"{video_id}{ext}")
                if os.path.exists(cached) and os.path.getsize(cached) > 0:
                    logger.info(f"Using cached YouTube download: {cached}")
                    return cached

            logger.info(f"Downloading YouTube video: {source_url} (ID: {video_id})")
            from ..utils.async_helpers import run_in_thread
            video_path = await run_in_thread(download_youtube_video, source_url, 3, None)
            if not video_path:
                raise ValueError(f"yt-dlp failed to download YouTube video: {source_url}")
            logger.info(f"YouTube download complete: {video_path}")
            return str(video_path)

        filename = f"campaign_source_{abs(hash(source_url))}.mp4"
        filepath = os.path.join(output_dir, filename)

        if os.path.exists(filepath) and os.path.getsize(filepath) > 0:
            logger.info(f"Source video already cached at {filepath}")
            return filepath

        download_url = source_url

        # Check for Google Drive
        drive_id = cls.extract_drive_file_id(source_url)
        if drive_id:
            download_url = f"https://drive.google.com/uc?export=download&id={drive_id}"

        # Check for Dropbox
        if "dropbox.com" in source_url:
            download_url = cls.format_dropbox_direct_url(source_url)

        logger.info(f"Downloading campaign source video from {download_url}...")
        async with httpx.AsyncClient(follow_redirects=True, timeout=600.0) as client:
            async with client.stream("GET", download_url) as response:
                if response.status_code != 200:
                    raise ValueError(f"Failed to download video from link. HTTP status {response.status_code}")
                
                with open(filepath, "wb") as f:
                    async for chunk in response.aiter_bytes(chunk_size=1024 * 1024):
                        f.write(chunk)

        logger.info(f"Successfully downloaded campaign source to {filepath}")
        return filepath

    @classmethod
    async def download_all_video_sources(cls, raw_urls_text: Optional[str], output_dir: str) -> List[str]:
        """
        Ingests multiple video URLs provided in a campaign and returns local filepaths.
        """
        urls = cls.parse_urls_list(raw_urls_text)
        if not urls and raw_urls_text:
            urls = [raw_urls_text.strip()]

        downloaded_paths = []
        for url in urls:
            try:
                path = await cls.download_video_source(url, output_dir)
                downloaded_paths.append(path)
            except Exception as e:
                logger.error(f"Failed to ingest source video {url}: {e}")

        return downloaded_paths

