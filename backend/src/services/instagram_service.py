"""
Instagram Service for Teek using instagrapi.
Handles session management, profile bio/link updates, direct Reels uploads, and view count tracking.
"""

import os
import logging
from typing import Optional, List, Dict, Any

logger = logging.getLogger(__name__)

# Lazy import instagrapi to allow server startup even if instagrapi is being installed
try:
    from instagrapi import Client
    from instagrapi.types import Usertag
    INSTAGRAPI_AVAILABLE = True
except ImportError:
    INSTAGRAPI_AVAILABLE = False
    logger.warning("instagrapi package not found. Instagram direct posting will run in mock mode until installed.")

class InstagramService:
    SESSION_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "..", "temp", "insta_sessions")

    @classmethod
    def _get_client(cls, username: str, password: Optional[str] = None) -> Any:
        if not INSTAGRAPI_AVAILABLE:
            raise RuntimeError("instagrapi library is not installed. Run 'pip install instagrapi'")

        os.makedirs(cls.SESSION_DIR, exist_ok=True)
        session_file = os.path.join(cls.SESSION_DIR, f"{username}_session.json")

        cl = Client()
        # Set realistic mobile user agent settings
        cl.delay_range = [2, 5]

        if os.path.exists(session_file):
            try:
                cl.load_settings(session_file)
                logger.info(f"Loaded existing Instagram session for '{username}'")
            except Exception as e:
                logger.warning(f"Could not load session settings for '{username}': {e}")

        if password:
            clean_pwd = password.strip()
            # If password is provided as a sessionid cookie (e.g. sessionid=... or raw sessionid token)
            if clean_pwd.startswith("sessionid=") or len(clean_pwd) > 30 and "%3A" in clean_pwd:
                session_id = clean_pwd.replace("sessionid=", "").strip()
                try:
                    cl.login_by_sessionid(session_id)
                    cl.dump_settings(session_file)
                    logger.info(f"Successfully logged into Instagram as '{username}' via sessionid cookie.")
                    return cl
                except Exception as e:
                    logger.warning(f"sessionid login failed: {e}")

            try:
                cl.login(username, clean_pwd)
                cl.dump_settings(session_file)
                logger.info(f"Successfully logged into Instagram as '{username}' and saved session.")
            except Exception as e:
                logger.error(f"Instagram login failed for '{username}': {e}")
                # Attempt login_by_sessionid if password was passed as raw token
                if len(clean_pwd) > 20:
                    try:
                        cl.login_by_sessionid(clean_pwd)
                        cl.dump_settings(session_file)
                        logger.info(f"Logged into Instagram via raw session token fallback for '{username}'")
                        return cl
                    except Exception:
                        pass
                raise ValueError(f"Instagram authentication failed for @{username}: {str(e)}")

        return cl

    @classmethod
    def sync_profile_bio_and_link(cls, username: str, password: str, bio_text: str, external_url: Optional[str] = None) -> bool:
        """
        Updates the dedicated Instagram account profile bio and website link.
        """
        cl = cls._get_client(username, password)
        try:
            if bio_text:
                cl.account_set_biography(bio_text)
                logger.info(f"Updated bio for @{username}")

            if external_url:
                cl.account_set_external_url(external_url)
                logger.info(f"Updated external URL for @{username} to {external_url}")

            return True
        except Exception as e:
            logger.error(f"Failed to sync profile for @{username}: {e}")
            raise RuntimeError(f"Failed to update profile for @{username}: {e}")

    @classmethod
    def upload_reel(
        cls,
        username: str,
        password: str,
        video_path: str,
        caption: str,
        usertags: Optional[List[str]] = None,
    ) -> str:
        """
        Uploads local video clip directly to Instagram Reels with caption and tags.
        Returns the media primary key (pk) ID.
        """
        if not os.path.exists(video_path):
            raise FileNotFoundError(f"Video file not found at {video_path}")

        cl = cls._get_client(username, password)

        # Build user tag objects if handles are provided
        usertag_objects = []
        if usertags:
            for handle in usertags:
                clean_handle = handle.lstrip("@").strip()
                if not clean_handle:
                    continue
                try:
                    user_info = cl.user_info_by_username(clean_handle)
                    if user_info and user_info.pk:
                        from instagrapi.types import UserShort
                        u_short = UserShort(pk=str(user_info.pk), username=user_info.username)
                        usertag_objects.append(Usertag(user=u_short, x=0.5, y=0.5))
                except Exception as tag_err:
                    logger.warning(f"Could not resolve Instagram handle @{clean_handle}: {tag_err}")

        logger.info(f"Uploading Reel '{video_path}' to @{username} with {len(usertag_objects)} user tags...")

        try:
            upload_kwargs = {
                "path": video_path,
                "caption": caption,
            }
            if usertag_objects:
                upload_kwargs["usertags"] = usertag_objects

            media = cl.clip_upload(**upload_kwargs)
            media_id = str(media.pk)
            logger.info(f"Reel successfully published for @{username}! Media ID: {media_id}")
            return media_id
        except Exception as e:
            logger.error(f"Reel upload failed for @{username}: {e}")
            raise RuntimeError(f"Reel upload failed for @{username}: {e}")

    @classmethod
    def get_reel_views(cls, username: str, media_id: str) -> int:
        """
        Fetches current play/view count for a published Reel.
        """
        try:
            cl = cls._get_client(username)
            media = cl.media_info(media_id)
            view_count = getattr(media, "play_count", None) or getattr(media, "view_count", 0) or 0
            return int(view_count)
        except Exception as e:
            logger.warning(f"Could not fetch views for media {media_id}: {e}")
            return 0
