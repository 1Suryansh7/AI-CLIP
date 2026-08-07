-- Migration 003: Add style customization columns to clipping_campaigns
-- These store the user's finalized clip style settings from the preview editor

ALTER TABLE clipping_campaigns
  ADD COLUMN IF NOT EXISTS subtitle_template VARCHAR(50) DEFAULT 'word-focus',
  ADD COLUMN IF NOT EXISTS highlight_color VARCHAR(7) DEFAULT '#FFFF00',
  ADD COLUMN IF NOT EXISTS margin_v_ratio FLOAT DEFAULT 0.42;
