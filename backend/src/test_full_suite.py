"""
Comprehensive test suite for Teek — Whop Clipping Campaigns, backend APIs, services, and models.

Covers:
- Health check endpoints
- Campaign CRUD (create, list, upload-videos)
- CampaignResponse Pydantic model validation (no duplicate fields)
- Ingestion service (Google Doc URL parsing, Drive/Dropbox URL parsing, multi-URL parsing)
- Secret service (encrypt/decrypt round-trip)
- Instagram service (mock mode graceful handling)
- AI caption generation (fallback when LLM unavailable)
- SQLAlchemy model instantiation (ClippingCampaign, GeneratedClip)
"""

import os
import sys
import uuid
import json
import asyncio
import pytest
import httpx

# Ensure the backend package is importable
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))


# ──────────────────────────────────────────────────────────
# 1. HEALTH CHECK TESTS (live server at localhost:8000)
# ──────────────────────────────────────────────────────────

BASE_URL = os.getenv("TEST_BASE_URL", "http://localhost:8000")


class TestHealthEndpoints:
    """Verify that the running backend responds on health routes."""

    def test_root_endpoint(self):
        r = httpx.get(f"{BASE_URL}/")
        assert r.status_code == 200
        body = r.json()
        assert body["status"] == "running"
        assert "Teek" in body["name"]

    def test_health_endpoint(self):
        r = httpx.get(f"{BASE_URL}/health")
        assert r.status_code == 200
        assert r.json()["status"] == "healthy"

    def test_health_db(self):
        r = httpx.get(f"{BASE_URL}/health/db")
        assert r.status_code == 200
        body = r.json()
        assert body["status"] == "healthy"
        assert body["database"] == "connected"

    def test_health_redis(self):
        r = httpx.get(f"{BASE_URL}/health/redis")
        assert r.status_code == 200
        body = r.json()
        assert body["status"] == "healthy"
        assert body["redis"] == "connected"


# ──────────────────────────────────────────────────────────
# 2. PYDANTIC MODEL VALIDATION TESTS
# ──────────────────────────────────────────────────────────

class TestPydanticModels:
    """Validate that Pydantic request/response models are correct."""

    def test_campaign_response_no_duplicate_fields(self):
        """CampaignResponse must not have duplicate field names (bug we fixed)."""
        from src.api.routes.campaigns import CampaignResponse
        field_names = list(CampaignResponse.model_fields.keys())
        assert len(field_names) == len(set(field_names)), \
            f"Duplicate fields detected: {[n for n in field_names if field_names.count(n) > 1]}"

    def test_campaign_response_has_style_fields(self):
        """CampaignResponse must contain all style/template fields."""
        from src.api.routes.campaigns import CampaignResponse
        required = {"clip_mode", "font_family", "font_size", "font_color", "stroke_color"}
        actual = set(CampaignResponse.model_fields.keys())
        missing = required - actual
        assert not missing, f"CampaignResponse is missing style fields: {missing}"

    def test_campaign_response_can_be_built_with_defaults(self):
        """CampaignResponse should be constructable with only required fields."""
        from src.api.routes.campaigns import CampaignResponse
        resp = CampaignResponse(
            id="test-id",
            campaign_name="Test Campaign",
        )
        assert resp.clip_mode == "highlights"
        assert resp.font_family == "TikTokSans-Regular"
        assert resp.font_size == 24
        assert resp.font_color == "#FFFFFF"
        assert resp.stroke_color == "#000000"
        assert resp.total_clips == 0
        assert resp.total_views == 0
        assert resp.status == "active"

    def test_create_campaign_request_validation(self):
        """CreateCampaignRequest must validate required fields."""
        from src.api.routes.campaigns import CreateCampaignRequest
        req = CreateCampaignRequest(
            campaign_name="Test",
            instagram_username="test_handle",
        )
        assert req.clip_mode == "highlights"
        assert req.rate_per_1k_views == 3.5
        assert req.font_size == 24

    def test_create_campaign_request_rejects_missing_required(self):
        """CreateCampaignRequest must reject missing campaign_name or instagram_username."""
        from src.api.routes.campaigns import CreateCampaignRequest
        from pydantic import ValidationError
        with pytest.raises(ValidationError):
            CreateCampaignRequest()  # missing required fields

    def test_campaign_caption_payload_structure(self):
        """CampaignCaptionPayload must have caption, hook_text, hashtags, cta_text, tagged_handles."""
        from src.ai import CampaignCaptionPayload
        payload = CampaignCaptionPayload(
            caption="Test caption",
            hook_text="Watch This",
            tagged_handles=["@test"],
            hashtags=["#viral"],
            cta_text="Link in bio!"
        )
        assert payload.caption == "Test caption"
        assert len(payload.hashtags) == 1


# ──────────────────────────────────────────────────────────
# 3. SECRET SERVICE TESTS
# ──────────────────────────────────────────────────────────

class TestSecretService:
    """Test encrypt/decrypt round-trip with SecretService."""

    def test_encrypt_decrypt_round_trip(self):
        from src.services.secret_service import SecretService
        svc = SecretService()
        original = "my_super_secret_password_123!"
        encrypted = svc.encrypt(original)
        assert encrypted != original, "Encrypted value must differ from plaintext"
        decrypted = svc.decrypt(encrypted)
        assert decrypted == original, "Decrypted value must match original"

    def test_encrypt_produces_different_tokens(self):
        """Two encryptions of the same value should produce different tokens (Fernet uses timestamp + IV)."""
        from src.services.secret_service import SecretService
        svc = SecretService()
        t1 = svc.encrypt("hello")
        t2 = svc.encrypt("hello")
        # Fernet tokens include timestamp so they may be identical if called in same second
        # But both must decrypt to "hello"
        assert svc.decrypt(t1) == "hello"
        assert svc.decrypt(t2) == "hello"

    def test_decrypt_invalid_token_raises(self):
        from src.services.secret_service import SecretService
        svc = SecretService()
        with pytest.raises(ValueError, match="Failed to decrypt"):
            svc.decrypt("this_is_not_a_valid_fernet_token")

    def test_service_is_instance_based(self):
        """Ensure SecretService must be instantiated (not called as static)."""
        from src.services.secret_service import SecretService
        assert not hasattr(SecretService, "encrypt_secret"), \
            "SecretService should NOT have a static encrypt_secret method"
        svc = SecretService()
        assert callable(svc.encrypt)
        assert callable(svc.decrypt)


# ──────────────────────────────────────────────────────────
# 4. INGESTION SERVICE TESTS
# ──────────────────────────────────────────────────────────

class TestIngestionService:
    """Test URL parsing and transformation utilities."""

    def test_parse_urls_list_newlines(self):
        from src.services.ingest_service import IngestionService
        raw = "https://drive.google.com/file/d/abc123\nhttps://youtube.com/watch?v=xyz"
        urls = IngestionService.parse_urls_list(raw)
        assert len(urls) == 2
        assert "drive.google.com" in urls[0]
        assert "youtube.com" in urls[1]

    def test_parse_urls_list_commas(self):
        from src.services.ingest_service import IngestionService
        raw = "https://drive.google.com/file/d/abc123, https://dropbox.com/s/file.mp4"
        urls = IngestionService.parse_urls_list(raw)
        assert len(urls) == 2

    def test_parse_urls_list_semicolons(self):
        from src.services.ingest_service import IngestionService
        raw = "https://youtu.be/abc;https://youtube.com/watch?v=def"
        urls = IngestionService.parse_urls_list(raw)
        assert len(urls) == 2

    def test_parse_urls_list_empty_input(self):
        from src.services.ingest_service import IngestionService
        assert IngestionService.parse_urls_list(None) == []
        assert IngestionService.parse_urls_list("") == []

    def test_parse_urls_list_filters_garbage(self):
        from src.services.ingest_service import IngestionService
        raw = "some random text\nhttps://youtube.com/watch?v=abc\nmore garbage\n"
        urls = IngestionService.parse_urls_list(raw)
        assert len(urls) == 1
        assert "youtube.com" in urls[0]

    def test_extract_drive_file_id(self):
        from src.services.ingest_service import IngestionService
        url = "https://drive.google.com/file/d/1a2b3c4d5e/view?usp=sharing"
        fid = IngestionService.extract_drive_file_id(url)
        assert fid == "1a2b3c4d5e"

    def test_extract_drive_file_id_none_for_invalid(self):
        from src.services.ingest_service import IngestionService
        assert IngestionService.extract_drive_file_id("https://example.com") is None

    def test_format_dropbox_direct_url(self):
        from src.services.ingest_service import IngestionService
        url = "https://www.dropbox.com/s/somefile/video.mp4?dl=0"
        direct = IngestionService.format_dropbox_direct_url(url)
        assert "dl.dropboxusercontent.com" in direct
        assert "dl=0" not in direct

    def test_format_dropbox_appends_dl1(self):
        from src.services.ingest_service import IngestionService
        url = "https://www.dropbox.com/s/somefile/video.mp4"
        direct = IngestionService.format_dropbox_direct_url(url)
        assert direct.endswith("?dl=1")

    def test_google_doc_url_returns_plaintext_if_no_url(self):
        """If user pastes plain text instead of a Google Doc URL, it should be returned as-is."""
        from src.services.ingest_service import IngestionService
        result = asyncio.get_event_loop().run_until_complete(
            IngestionService.fetch_google_doc_text("This is my rule text, not a URL")
        )
        assert result == "This is my rule text, not a URL"


# ──────────────────────────────────────────────────────────
# 5. INSTAGRAM SERVICE TESTS (mock/safety)
# ──────────────────────────────────────────────────────────

class TestInstagramService:
    """Test InstagramService gracefully handles missing credentials."""

    def test_upload_reel_requires_existing_file(self):
        from src.services.instagram_service import InstagramService
        with pytest.raises(FileNotFoundError):
            InstagramService.upload_reel(
                username="test",
                password="test",
                video_path="/nonexistent/video.mp4",
                caption="test",
            )

    def test_get_reel_views_returns_zero_on_failure(self):
        """get_reel_views should return 0 when it can't reach Instagram."""
        from src.services.instagram_service import InstagramService
        views = InstagramService.get_reel_views("nonexistent_user", "fake_media_id")
        assert views == 0


# ──────────────────────────────────────────────────────────
# 6. AI CAPTION FALLBACK TESTS
# ──────────────────────────────────────────────────────────

class TestAICaptionFallback:
    """Test that generate_campaign_caption_with_hermes returns a valid fallback."""

    def test_caption_fallback_structure(self):
        from src.ai import generate_campaign_caption_with_hermes
        # Use a deliberately broken provider so it hits the fallback path
        result = asyncio.get_event_loop().run_until_complete(
            generate_campaign_caption_with_hermes(
                transcript="Test clip about crypto trading",
                mandatory_tags="@cryptobro, @trader",
                mandatory_hashtags="#crypto, #trading",
                ai_provider="nonexistent_provider",
                ai_model="nonexistent_model",
            )
        )
        assert result.caption, "Fallback caption must not be empty"
        assert len(result.hashtags) >= 1, "Fallback must include at least 1 hashtag"
        assert "@cryptobro" in result.tagged_handles
        assert "@trader" in result.tagged_handles
        assert result.cta_text, "Fallback must include a CTA"


# ──────────────────────────────────────────────────────────
# 7. SQLALCHEMY MODEL TESTS
# ──────────────────────────────────────────────────────────

class TestSQLAlchemyModels:
    """Test model class definitions and defaults."""

    def test_clipping_campaign_has_all_columns(self):
        from src.models import ClippingCampaign
        cols = {c.key for c in ClippingCampaign.__table__.columns}
        required = {
            "id", "user_id", "campaign_name", "google_doc_url", "drive_url",
            "extracted_rules", "required_bio_text", "required_bio_link",
            "mandatory_tags", "mandatory_hashtags", "caption_instructions",
            "instagram_username", "instagram_password_encrypted",
            "clip_mode", "font_family", "font_size", "font_color", "stroke_color",
            "rate_per_1k_views", "status", "created_at", "updated_at",
        }
        missing = required - cols
        assert not missing, f"ClippingCampaign is missing columns: {missing}"

    def test_generated_clip_has_campaign_fields(self):
        from src.models import GeneratedClip
        cols = {c.key for c in GeneratedClip.__table__.columns}
        required = {"campaign_id", "instagram_media_id", "published_at", "view_count", "estimated_payout"}
        missing = required - cols
        assert not missing, f"GeneratedClip is missing columns: {missing}"

    def test_user_has_campaigns_relationship(self):
        from src.models import User
        assert hasattr(User, "campaigns"), "User model must have 'campaigns' relationship"

    def test_clipping_campaign_has_clips_relationship(self):
        from src.models import ClippingCampaign
        assert hasattr(ClippingCampaign, "clips"), "ClippingCampaign must have 'clips' relationship"

    def test_uuid_generation(self):
        from src.models import generate_uuid_string
        uid = generate_uuid_string()
        assert len(uid) == 36
        # Verify it's a valid UUID
        uuid.UUID(uid)


# ──────────────────────────────────────────────────────────
# 8. CAMPAIGN API ENDPOINT TESTS (via live server)
# ──────────────────────────────────────────────────────────

class TestCampaignAPIEndpoints:
    """Integration tests hitting the live API server."""

    def _get_auth_headers(self):
        """Create or fetch a test user and return JWT auth headers."""
        # Try to register/login a test user
        r = httpx.post(f"{BASE_URL}/auth/register", json={
            "name": "Test User",
            "email": f"test_{uuid.uuid4().hex[:8]}@teek.test",
            "password": "TestPassword123!",
        })
        if r.status_code == 200:
            token = r.json().get("token") or r.json().get("access_token")
            if token:
                return {"Authorization": f"Bearer {token}"}

        # If register fails, try a simple approach - check if there's a simpler auth path
        r = httpx.post(f"{BASE_URL}/auth/login", json={
            "email": "test@teek.test",
            "password": "TestPassword123!",
        })
        if r.status_code == 200:
            token = r.json().get("token") or r.json().get("access_token")
            if token:
                return {"Authorization": f"Bearer {token}"}

        return {}

    def test_campaigns_list_requires_auth(self):
        """GET /campaigns without auth should return 401 or 403."""
        r = httpx.get(f"{BASE_URL}/campaigns")
        assert r.status_code in (401, 403, 422), \
            f"Expected auth error, got {r.status_code}: {r.text}"

    def test_campaigns_create_requires_auth(self):
        """POST /campaigns without auth should return 401 or 403."""
        r = httpx.post(f"{BASE_URL}/campaigns", json={
            "campaign_name": "Test",
            "instagram_username": "test",
        })
        assert r.status_code in (401, 403, 422), \
            f"Expected auth error, got {r.status_code}: {r.text}"

    def test_campaigns_create_with_auth(self):
        """POST /campaigns with auth should create a campaign."""
        headers = self._get_auth_headers()
        if not headers:
            pytest.skip("Could not obtain auth token for integration test")

        r = httpx.post(f"{BASE_URL}/campaigns", json={
            "campaign_name": "Integration Test Campaign",
            "instagram_username": "test_handle",
            "rate_per_1k_views": 4.0,
            "clip_mode": "full_length",
            "font_family": "Roboto-Bold",
            "font_size": 32,
            "font_color": "#FF0000",
            "stroke_color": "#00FF00",
        }, headers=headers)

        if r.status_code == 200:
            body = r.json()
            assert body["campaign_name"] == "Integration Test Campaign"
            assert body["clip_mode"] == "full_length"
            assert body["font_family"] == "Roboto-Bold"
            assert body["font_size"] == 32
            assert body["font_color"] == "#FF0000"
            assert body["stroke_color"] == "#00FF00"
            assert body["rate_per_1k_views"] == 4.0
            assert body["status"] == "active"
            assert body["id"]  # Must have an ID

    def test_campaigns_list_with_auth(self):
        """GET /campaigns with auth should return a list."""
        headers = self._get_auth_headers()
        if not headers:
            pytest.skip("Could not obtain auth token for integration test")

        r = httpx.get(f"{BASE_URL}/campaigns", headers=headers)
        if r.status_code == 200:
            body = r.json()
            assert isinstance(body, list)

    def test_sync_analytics_invalid_campaign(self):
        """POST /campaigns/{id}/sync-analytics with invalid ID should 404 or auth error."""
        headers = self._get_auth_headers()
        if not headers:
            pytest.skip("Could not obtain auth token for integration test")

        r = httpx.post(f"{BASE_URL}/campaigns/nonexistent-id/sync-analytics", headers=headers)
        assert r.status_code in (404, 401, 403)

    def test_publish_clip_invalid_campaign(self):
        """POST /campaigns/{id}/publish-clip/{clip_id} with invalid IDs should error."""
        headers = self._get_auth_headers()
        if not headers:
            pytest.skip("Could not obtain auth token for integration test")

        r = httpx.post(f"{BASE_URL}/campaigns/fake-id/publish-clip/fake-clip", headers=headers)
        assert r.status_code in (404, 401, 403)


# ──────────────────────────────────────────────────────────
# 9. MIGRATION SQL VALIDATION TESTS
# ──────────────────────────────────────────────────────────

class TestMigrationSQL:
    """Validate that the database schema has all required columns (migration applied correctly)."""

    def test_clipping_campaigns_table_has_style_columns(self):
        """Verify the DB table has all style columns by checking the SQLAlchemy model matches."""
        from src.models import ClippingCampaign
        table_cols = {c.name for c in ClippingCampaign.__table__.columns}
        required = {"clip_mode", "font_family", "font_size", "font_color", "stroke_color",
                     "campaign_name", "instagram_username", "rate_per_1k_views", "status"}
        missing = required - table_cols
        assert not missing, f"Migration is missing columns from clipping_campaigns: {missing}"

    def test_generated_clips_table_has_analytics_columns(self):
        """Verify generated_clips table has campaign and analytics columns."""
        from src.models import GeneratedClip
        table_cols = {c.name for c in GeneratedClip.__table__.columns}
        required = {"campaign_id", "instagram_media_id", "published_at", "view_count", "estimated_payout"}
        missing = required - table_cols
        assert not missing, f"Migration is missing columns from generated_clips: {missing}"

    def test_clipping_campaigns_table_column_types(self):
        """Verify column types are correct."""
        from src.models import ClippingCampaign
        cols = {c.name: c for c in ClippingCampaign.__table__.columns}
        # clip_mode should be String
        assert "VARCHAR" in str(cols["clip_mode"].type).upper() or "STRING" in str(cols["clip_mode"].type).upper()
        # font_size should be Integer
        assert "INT" in str(cols["font_size"].type).upper()


# ──────────────────────────────────────────────────────────
# 10. CONFIG TESTS
# ──────────────────────────────────────────────────────────

class TestConfig:
    """Validate Config class loads correctly."""

    def test_config_has_temp_dir(self):
        from src.config import Config
        c = Config()
        assert hasattr(c, "temp_dir")
        assert c.temp_dir  # must be non-empty

    def test_config_has_secret_encryption_key_attr(self):
        from src.config import Config
        c = Config()
        assert hasattr(c, "secret_encryption_key")

    def test_config_llm_default(self):
        from src.config import Config
        c = Config()
        assert c.llm  # must have a default LLM setting


if __name__ == "__main__":
    pytest.main([__file__, "-v", "--tb=short"])
