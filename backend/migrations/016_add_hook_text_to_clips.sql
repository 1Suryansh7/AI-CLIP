-- Migration: Add title and hook_text columns to generated_clips
-- These columns store the on-screen hype text overlay for clip rendering

DO $$
BEGIN
    -- Add title column if not exists
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'generated_clips' AND column_name = 'title'
    ) THEN
        ALTER TABLE generated_clips ADD COLUMN title TEXT;
    END IF;

    -- Add hook_text column if not exists
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'generated_clips' AND column_name = 'hook_text'
    ) THEN
        ALTER TABLE generated_clips ADD COLUMN hook_text TEXT;
    END IF;
END $$;
