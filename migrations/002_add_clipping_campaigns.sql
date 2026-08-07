-- Migration: 002_add_clipping_campaigns.sql
-- Create clipping_campaigns table and update generated_clips table

CREATE TABLE IF NOT EXISTS clipping_campaigns (
    id VARCHAR(36) PRIMARY KEY,
    user_id VARCHAR(36) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    campaign_name VARCHAR(255) NOT NULL,
    google_doc_url TEXT,
    drive_url TEXT,
    extracted_rules TEXT,
    required_bio_text TEXT,
    required_bio_link VARCHAR(500),
    mandatory_tags TEXT,
    mandatory_hashtags TEXT,
    caption_instructions TEXT,
    instagram_username VARCHAR(100),
    instagram_password_encrypted TEXT,
    clip_mode VARCHAR(20) DEFAULT 'highlights' NOT NULL,
    font_family VARCHAR(100) DEFAULT 'TikTokSans-Regular',
    font_size INTEGER DEFAULT 24,
    font_color VARCHAR(7) DEFAULT '#FFFFFF',
    stroke_color VARCHAR(7) DEFAULT '#000000',
    rate_per_1k_views DOUBLE PRECISION DEFAULT 3.5 NOT NULL,
    status VARCHAR(20) DEFAULT 'active' NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

DO $$ 
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='clipping_campaigns' AND column_name='clip_mode') THEN
        ALTER TABLE clipping_campaigns ADD COLUMN clip_mode VARCHAR(20) DEFAULT 'highlights' NOT NULL;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='clipping_campaigns' AND column_name='font_family') THEN
        ALTER TABLE clipping_campaigns ADD COLUMN font_family VARCHAR(100) DEFAULT 'TikTokSans-Regular';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='clipping_campaigns' AND column_name='font_size') THEN
        ALTER TABLE clipping_campaigns ADD COLUMN font_size INTEGER DEFAULT 24;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='clipping_campaigns' AND column_name='font_color') THEN
        ALTER TABLE clipping_campaigns ADD COLUMN font_color VARCHAR(7) DEFAULT '#FFFFFF';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='clipping_campaigns' AND column_name='stroke_color') THEN
        ALTER TABLE clipping_campaigns ADD COLUMN stroke_color VARCHAR(7) DEFAULT '#000000';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='generated_clips' AND column_name='campaign_id') THEN
        ALTER TABLE generated_clips ADD COLUMN campaign_id VARCHAR(36) REFERENCES clipping_campaigns(id) ON DELETE SET NULL;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='generated_clips' AND column_name='instagram_media_id') THEN
        ALTER TABLE generated_clips ADD COLUMN instagram_media_id VARCHAR(100);
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='generated_clips' AND column_name='published_at') THEN
        ALTER TABLE generated_clips ADD COLUMN published_at TIMESTAMPTZ;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='generated_clips' AND column_name='view_count') THEN
        ALTER TABLE generated_clips ADD COLUMN view_count INTEGER DEFAULT 0 NOT NULL;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='generated_clips' AND column_name='estimated_payout') THEN
        ALTER TABLE generated_clips ADD COLUMN estimated_payout DOUBLE PRECISION DEFAULT 0.0 NOT NULL;
    END IF;
END $$;
