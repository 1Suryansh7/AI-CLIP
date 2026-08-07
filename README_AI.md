# 🤖 Teek — AI Agent & Developer Reference Guide (`README_AI.md`)

Welcome to the **Teek** AI developer & agent specification guide. This document provides a high-level and granular overview of the Teek codebase, architecture, environment settings, data pipelines, key services, and developer rules for AI coding assistants.

---

## 📌 1. Project Overview

**Teek** is an open-source, self-hosted AI video clipping platform designed as an alternative to OpusClip, Veed.io, and Caption.com. 

### Core Capabilities
- **Video Ingestion**: Supports YouTube URLs and direct file uploads.
- **Audio Transcription**: Uses local OpenAI Whisper models or remote services (AssemblyAI) for word-level timestamps.
- **AI Clip Selection**: Leverages LLMs (OpenAI, Anthropic, Google Gemini, DeepSeek, ZhipuAI) to evaluate transcript segments and extract viral, high-hook potential short clips.
- **Dynamic Face & Subject Tracking**: Uses MediaPipe and OpenCV fallback for automated 9:16 vertical crop framing.
- **ASS Subtitle Engine**: Generates highly styled word-level animated captions (Hype, Classic, Retro, Minimalist, etc.) with full RTL language support.
- **Clip Studio & Review**: Provides side-by-side clip editing, duration adjustments, styling customization, and automated campaign workflows.

---

## 🏗️ 2. Repository Architecture

Teek is structured as a monorepo containing two core applications:

```
teek/
├── backend/                  # FastAPI Application (Python 3.10+)
│   ├── src/
│   │   ├── api/routes/       # REST API endpoints (tasks, clips, transcripts, campaigns)
│   │   ├── services/         # Business logic (task orchestration, ingest, Instagram publishing)
│   │   ├── repositories/     # Data access layer (PostgreSQL CRUD operations)
│   │   ├── ass_generator.py  # Subtitle styling and ASS event generation
│   │   ├── ass_renderer.py   # Subtitle rendering engine
│   │   ├── video_utils.py    # MediaPipe framing, FFmpeg wrappers, aspect ratio conversion
│   │   ├── ai.py             # LLM API integration & clip scoring logic
│   │   ├── config.py         # Centralized configuration & environment loader
│   │   ├── models.py         # Pydantic data schemas & database models
│   │   └── main_refactored.py # Primary production FastAPI app entrypoint
│   └── tests/                # Unit and integration tests
│
├── frontend/                 # Next.js 15 App Router Application (React 19, TypeScript, Tailwind)
│   ├── src/
│   │   ├── app/              # Page routes (/tasks, /review/[id], /studio/[id], /campaigns)
│   │   ├── components/       # Reusable React components (EditorView, ClipPreviewModal, Sidebar)
│   │   └── contexts/         # State providers (UploadContext, TaskContext)
│
├── docs/                     # Canonical documentation (docs/config.md, local-host-mappings.md)
├── migrations/               # SQL database migration scripts
├── docker-compose.yml        # Docker orchestration (Postgres, Redis, Backend, Frontend)
├── QUICKSTART.md             # Developer quickstart guide
└── AGENTS.md                 # Agent behavior rules and configuration standards
```

---

## 🔑 3. Key Modules & Navigation Map

### Backend Modules (`backend/src/`)
| Module | Path | Description |
| :--- | :--- | :--- |
| **Production Entrypoint** | [`backend/src/main_refactored.py`](file:///c:/Users/surya/teek/backend/src/main_refactored.py) | Primary FastAPI app initialization (used in Docker and production). |
| **Config Engine** | [`backend/src/config.py`](file:///c:/Users/surya/teek/backend/src/config.py) | Single source of truth for runtime configurations, env vars, and LLM setup. |
| **Task Service** | [`backend/src/services/task_service.py`](file:///c:/Users/surya/teek/backend/src/services/task_service.py) | Main pipeline orchestrator (download -> transcribe -> LLM clip selection -> render). |
| **Ingest Service** | [`backend/src/services/ingest_service.py`](file:///c:/Users/surya/teek/backend/src/services/ingest_service.py) | Handles YouTube `yt-dlp` downloads and video file validation. |
| **Clip Repository** | [`backend/src/repositories/clip_repository.py`](file:///c:/Users/surya/teek/backend/src/repositories/clip_repository.py) | Database operations for tasks, clips, transcripts, and campaigns. |
| **ASS Generator** | [`backend/src/ass_generator.py`](file:///c:/Users/surya/teek/backend/src/ass_generator.py) | Constructs `.ass` subtitle files with word-by-word highlight colors and timing. |
| **Video Utils** | [`backend/src/video_utils.py`](file:///c:/Users/surya/teek/backend/src/video_utils.py) | FFmpeg video cropping, MediaPipe face detection, and resolution conversion. |
| **AI LLM Engine** | [`backend/src/ai.py`](file:///c:/Users/surya/teek/backend/src/ai.py) | Prompts LLMs to analyze transcripts and identify engaging clip start/end times. |

### Frontend Pages & Components (`frontend/src/`)
| Page / Component | Path | Description |
| :--- | :--- | :--- |
| **Tasks & Processing** | [`frontend/src/app/tasks/[id]/page.tsx`](file:///c:/Users/surya/teek/frontend/src/app/tasks/%5Bid%5D/page.tsx) | Live task execution progress and clip generation state. |
| **Clip Review Grid** | [`frontend/src/app/review/[id]/page.tsx`](file:///c:/Users/surya/teek/frontend/src/app/review/%5Bid%5D/page.tsx) | Grid dashboard displaying generated clips with virality scores. |
| **Studio & Editor** | [`frontend/src/app/studio/[id]/page.tsx`](file:///c:/Users/surya/teek/frontend/src/app/studio/%5Bid%5D/page.tsx) | Interactive clip editor (`EditorView.tsx`) for subtitle tweaks and reframing. |
| **Editor Component** | [`frontend/src/components/clip/EditorView.tsx`](file:///c:/Users/surya/teek/frontend/src/components/clip/EditorView.tsx) | Full timeline editor, canvas subtitle renderer, and style selector. |
| **Clip Preview Modal** | [`frontend/src/components/clip/ClipPreviewModal.tsx`](file:///c:/Users/surya/teek/frontend/src/components/clip/ClipPreviewModal.tsx) | Side-by-side clip comparison player against original video. |
| **Navigation Sidebar** | [`frontend/src/components/layout/Sidebar.tsx`](file:///c:/Users/surya/teek/frontend/src/components/layout/Sidebar.tsx) | App layout sidebar and navigation links. |

---

## ⚙️ 4. Environment & Configuration Reference

Configured primarily via `.env` (refer to [`docs/config.md`](file:///c:/Users/surya/teek/docs/config.md) as the canonical reference):

### Critical Environment Variables
- **Model Provider & Choice**:
  - `LLM`: Primary model identifier (e.g. `openai:gpt-5-mini`, `google:gemini-2.5-flash`, `anthropic:claude-3-5-sonnet`).
  - `LLM_MODEL`: Legacy fallback model variable.
- **Whisper Transcription**:
  - `WHISPER_MODEL_SIZE`: Local Whisper model size (`tiny`, `base`, `small`, `medium`, `large-v3`).
  - `WHISPER_MODEL`: Legacy fallback Whisper variable.
- **API Keys**:
  - `OPENAI_API_KEY`, `DEEPSEEK_API_KEY`, `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, `ZAI_API_KEY`.
- **Database & Queue**:
  - `POSTGRES_URL`: PostgreSQL connection string.
  - `REDIS_URL`: Redis connection string.
- **Host & Ports**:
  - `APP_HOST`: Default `localhost` / `127.0.0.1`.
  - `FRONTEND_HOST_PORT`: Default `3000`.
  - `BACKEND_HOST_PORT`: Default `8000`.

---

## 🛡️ 5. Security & Data Protection Rules

To prevent leaking sensitive information:
1. **Never Commit Secrets**: Secrets, API keys, credentials files (`*.pem`, `cookies.txt`, `client_secret*.json`) must **never** be committed.
2. **Media & Binary Exclusion**: Media files (`*.mp4`, `*.mov`, `backend/uploads/`, `backend/clips/`) are ignored by `.gitignore`.
3. **Environment Isolation**: Always use `.env.example` as a template; `.env` and `.env.*` are strictly excluded from version control.

---

## 🚨 6. Rules for AI Coding Assistants

When working on this repository, all AI agents must follow these guidelines:

1. **Backend Entrypoint Alignment**:
   - Always prefer modifying and using `src.main_refactored:app`. Do not default to legacy `src.main:app`.
2. **Synchronized Documentation Updates**:
   - If updating configuration keys, model defaults, or runtime behavior, update these files simultaneously:
     1. [`backend/src/config.py`](file:///c:/Users/surya/teek/backend/src/config.py)
     2. [`docs/config.md`](file:///c:/Users/surya/teek/docs/config.md)
     3. `.env.example` and `backend/.env.example`
     4. [`QUICKSTART.md`](file:///c:/Users/surya/teek/QUICKSTART.md)
3. **Preserve Function & API Contracts**:
   - Check all calling sites using search tools before modifying function signatures or database schema models.
4. **Clean Code & Non-Destructive Editing**:
   - Preserve existing unrelated comments and docstrings.
   - Run local build or verification commands before declaring success.
