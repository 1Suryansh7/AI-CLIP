"use client";

import { useEffect, useState, useRef, useMemo } from "react";
import { useParams, useRouter } from "next/navigation";
import { AppLayout } from "@/components/layout/AppLayout";
import { useSession } from "@/lib/auth-client";
import { useJwt } from "@/contexts/jwt-context";
import { Play, Pause, Eye, EyeOff, Check, Scissors, Sparkles } from "lucide-react";
import { AssSubtitleRenderer } from "@/components/clip/AssSubtitleRenderer";

/**
 * Patch the font size inside an ASS subtitle string without a network round-trip.
 *
 * The ASS Style line stores the base font size as the 3rd comma-separated field:
 *   Style: Default,<FontName>,<fontSize>,…
 *
 * Dialogue events may also contain inline \fs{N} override tags (used by templates
 * that scale the active word, e.g. "explosive").  We scale those proportionally so
 * the size ratio between active and inactive words is preserved.
 */
function applyFontSizeToAss(ass: string, newSize: number): string {
  const match = ass.match(/^Style: Default,[^,]+,(\d+)/m);
  if (!match) return ass;
  const oldSize = parseInt(match[1]);
  if (oldSize === newSize) return ass;

  // Replace the base font size in the Style line
  let result = ass.replace(/(^Style: Default,[^,]+,)\d+/m, `$1${newSize}`);

  // Scale every \fs{N} tag proportionally (covers active-word pop sizes)
  result = result.replace(/\\fs(\d+)/g, (_, n) =>
    `\\fs${Math.round(parseInt(n) * newSize / oldSize)}`
  );

  return result;
}

interface TranscriptSegment {
  id: number;
  start_time: string;
  end_time: string;
  start_ms: number;
  end_ms: number;
  text: string;
  word_count: number;
}

interface Clip {
  id: string;
  start_time: string;
  end_time: string;
  duration: number;
  text: string;
  relevance_score: number;
  clip_order: number;
  title?: string;
  hook_text?: string;
}

interface TaskData {
  id: string;
  status: string;
  source: {
    title: string;
    url: string;
  };
  metadata?: {
    video_path?: string;
  };
}

interface PycapsTemplate {
  name: string;
  display_name: string;
  description: string;
  is_default: boolean;
}

const CLIP_COLORS = [
  "#256af4", "#3B82F6", "#10B981", "#F59E0B",
  "#EF4444", "#EC4899", "#14B8A6", "#256af4",
];

interface FontOption {
  value: string;
  name: string;
  category: string;
  is_default?: boolean;
}

const AVAILABLE_FONTS_LIST: FontOption[] = [
  { value: "BurbankBigCondensed-Black", name: "BURBANK BIG CONDENSED", category: "Heavy display font — Gaming / Viral Shorts", is_default: true },
  { value: "Montserrat-ExtraBold", name: "MONTSERRAT EXTRA BOLD", category: "Extra-bold modern geometric sans" },
  { value: "Montserrat-Bold", name: "MONTSERRAT BOLD", category: "Clean, punchy subtitle weight" },
  { value: "Montserrat-Regular", name: "MONTSERRAT REGULAR", category: "Standard clean geometric font" },
  { value: "Anton-Regular", name: "ANTON", category: "Impactful condensed headline style" },
  { value: "ArchivoBlack-Regular", name: "ARCHIVO BLACK", category: "Heavyweight ultra-bold font" },
  { value: "BebasNeue-Regular", name: "BEBAS NEUE", category: "All-caps condensed display style" },
  { value: "NotoSans-Regular", name: "NOTO SANS", category: "Universal clean readable font" },
  { value: "Poppins-SemiBold", name: "POPPINS SEMIBOLD", category: "Geometric rounded subtitle font" },
  { value: "THEBOLDFONT-FREEVERSION", name: "THE BOLD FONT", category: "High-energy bold caps" },
  { value: "TikTokSans-Regular", name: "TIKTOK SANS", category: "TikTok style video caption font" },
  { value: "Inter-Variable", name: "INTER", category: "Modern interface subtitle style" },
  { value: "Lato-Bold", name: "LATO BOLD", category: "Warm, legible bold font" },
  { value: "OpenSans-Variable", name: "OPEN SANS", category: "Neutral highly legible style" },
  { value: "Oswald-Variable", name: "OSWALD", category: "Narrow condensed font" },
  { value: "Roboto-Variable", name: "ROBOTO", category: "Classic balanced subtitle font" },
];

// Matches Arabic, Hebrew, and other RTL scripts
const RTL_REGEX = /[\u0591-\u07FF\uFB1D-\uFDFD\uFE70-\uFEFC]/;
function isRTL(text: string): boolean {
  return RTL_REGEX.test(text);
}

/** Parse "HH:MM:SS", "MM:SS", or float-string → seconds */
function parseTs(ts: string): number {
  if (!ts) return 0;
  const parts = ts.split(":").map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parseFloat(ts) || 0;
}

/** Format seconds → MM:SS */
function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
}

export default function ReviewPage() {
  const params = useParams();
  const router = useRouter();
  const { data: session } = useSession();
  const { jwt, apiFetch } = useJwt();
  const taskId = params.id as string;
  const apiUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

  const [task, setTask] = useState<TaskData | null>(null);
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [clips, setClips] = useState<Clip[]>([]);
  const [templates, setTemplates] = useState<PycapsTemplate[]>([]);
  const [isLoadingTemplates, setIsLoadingTemplates] = useState(false);
  const [activeTab, setActiveTab] = useState<"insights" | "transcript">("transcript");
  const [selectedStyle, setSelectedStyle] = useState("word-focus");
  const [selectedFont, setSelectedFont] = useState("BurbankBigCondensed-Black");
  const [fontColor, setFontColor] = useState("#FFFFFF");
  const [highlightColor, setHighlightColor] = useState("#FFFF00");
  const [marginVRatio, setMarginVRatio] = useState<number>(0.42);
  const [showSubtitles, setShowSubtitles] = useState(true);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isGenerating, setIsGenerating] = useState(false);
  const videoSrc = taskId ? `${apiUrl}/tasks/${taskId}/source-video` : null;
  const [transitionsEnabled, setTransitionsEnabled] = useState(false);
  const [aspectRatio, setAspectRatio] = useState<"9:16" | "1:1" | "16:9">("9:16");
  const [savingClipId, setSavingClipId] = useState<string | null>(null);
  const [subtitleStyle, setSubtitleStyle] = useState<{ font_size: number }>({ font_size: 28 });

  // On-Screen Hype Text custom styling states
  const [hookFont, setHookFont] = useState("BurbankBigCondensed-Black");
  const [hookColor, setHookColor] = useState("#FFFFFF");
  const [hookPosition, setHookPosition] = useState<"top" | "center" | "bottom">("top");
  const [hookFontSize, setHookFontSize] = useState<number>(26);
  const [hookShowBg, setHookShowBg] = useState<boolean>(true);

  // Canvas Frame & Background Padding states (White Card vs Dark)
  const [canvasStyle, setCanvasStyle] = useState<"dark" | "white_card" | "custom">("dark");
  const [padColor, setPadColor] = useState<string>("#000000");

  // baseAssContent: raw ASS from the backend (template style, default font size)
  const [baseAssContent, setBaseAssContent] = useState<string | null>(null);
  // assContent: font size patched client-side — instant, no network round-trip needed
  const assContent = useMemo(
    () => baseAssContent ? applyFontSizeToAss(baseAssContent, subtitleStyle.font_size) : null,
    [baseAssContent, subtitleStyle.font_size]
  );

  const videoRef = useRef<HTMLVideoElement>(null);
  const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null);
  const animFrameRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!jwt || !taskId) return;

    const fetchTask = async () => {
      const res = await apiFetch(`${apiUrl}/tasks/${taskId}`);
      if (res.ok) setTask(await res.json());
    };

    const fetchSegments = async () => {
      const res = await apiFetch(`${apiUrl}/tasks/${taskId}/transcript/segments`);
      if (res.ok) {
        const data = await res.json();
        setSegments(data.segments || []);
      }
    };

    const activeHookText = clips.length > 0 ? (clips[0].hook_text || clips[0].title || "") : "";

    const fetchAss = async () => {
      const effectivePadColor = canvasStyle === "white_card" ? "#FFFFFF" : padColor;
      const params = new URLSearchParams({
        template: selectedStyle,
        font_family: selectedFont,
        font_color: fontColor,
        highlight_color: highlightColor,
        margin_v_ratio: String(marginVRatio),
        hook_text: activeHookText,
        hook_font_family: hookFont,
        hook_font_color: canvasStyle === "white_card" && hookColor === "#FFFFFF" ? "#000000" : hookColor,
        hook_position: hookPosition,
        hook_font_size: String(hookFontSize),
        hook_show_bg: String(canvasStyle === "white_card" ? false : hookShowBg),
        pad_color: effectivePadColor,
        canvas_style: canvasStyle,
      });
      const res = await apiFetch(`${apiUrl}/tasks/${taskId}/transcript/ass?${params.toString()}`);
      if (res.ok) {
        const data = await res.json();
        setBaseAssContent(data.ass_content || null);
      }
    };

    const fetchClips = async () => {
      const res = await apiFetch(`${apiUrl}/tasks/${taskId}/clips`);
      if (res.ok) {
        const data = await res.json();
        setClips(data.clips || []);
      }
    };

    const fetchSubtitleDefaults = async () => {
      try {
        const res = await fetch(`${apiUrl}/subtitle-style/defaults`);
        if (res.ok) {
          const data = await res.json();
          if (data.defaults?.font_size) {
            setSubtitleStyle({ font_size: data.defaults.font_size });
          }
        }
      } catch {
        // keep default
      }
    };

    fetchTask();
    fetchSegments();
    fetchAss();
    fetchClips();
    fetchSubtitleDefaults();
  }, [taskId, jwt, apiUrl, apiFetch]);

  // Re-fetch base ASS whenever any style or hook setting changes
  const activeHookText = clips.length > 0 ? (clips[0].hook_text || clips[0].title || "") : "";
  useEffect(() => {
    if (!jwt || !taskId) return;
    const effectivePadColor = canvasStyle === "white_card" ? "#FFFFFF" : padColor;
    const params = new URLSearchParams({
      template: selectedStyle,
      font_family: selectedFont,
      font_color: fontColor,
      highlight_color: highlightColor,
      margin_v_ratio: String(marginVRatio),
      hook_text: activeHookText,
      hook_font_family: hookFont,
      hook_font_color: canvasStyle === "white_card" && hookColor === "#FFFFFF" ? "#000000" : hookColor,
      hook_position: hookPosition,
      hook_font_size: String(hookFontSize),
      hook_show_bg: String(canvasStyle === "white_card" ? false : hookShowBg),
      pad_color: effectivePadColor,
      canvas_style: canvasStyle,
    });
    apiFetch(`${apiUrl}/tasks/${taskId}/transcript/ass?${params.toString()}`)
      .then((r) => r.ok ? r.json() : null)
      .then((data) => { if (data) setBaseAssContent(data.ass_content || null); })
      .catch(() => { });
  }, [selectedStyle, selectedFont, fontColor, highlightColor, marginVRatio, activeHookText, hookFont, hookColor, hookPosition, hookFontSize, hookShowBg, canvasStyle, padColor, taskId, jwt, apiUrl, apiFetch]);

  // Fetch available templates from the backend
  useEffect(() => {
    const load = async () => {
      try {
        setIsLoadingTemplates(true);
        const res = await fetch(`${apiUrl}/pycaps-templates`);
        if (res.ok) {
          const data = await res.json();
          const list: PycapsTemplate[] = data.templates || [];
          setTemplates(list);
          // Set the default template as selected if we haven't picked one yet
          const def = list.find((t) => t.is_default);
          if (def) setSelectedStyle(def.name);
        }
      } catch {
        // keep default
      } finally {
        setIsLoadingTemplates(false);
      }
    };
    load();
  }, [apiUrl]);

  // Smooth currentTime updates via requestAnimationFrame
  useEffect(() => {
    const tick = () => {
      if (videoRef.current) {
        setCurrentTime(videoRef.current.currentTime);
      }
      animFrameRef.current = requestAnimationFrame(tick);
    };
    animFrameRef.current = requestAnimationFrame(tick);
    return () => { if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current); };
  }, []);

  const handlePlayPause = () => {
    if (!videoRef.current) return;
    if (isPlaying) videoRef.current.pause();
    else videoRef.current.play();
    setIsPlaying(!isPlaying);
  };

  const handleLoadedMetadata = () => {
    if (videoRef.current) {
      setDuration(videoRef.current.duration);
      setVideoEl(videoRef.current);
    }
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const time = parseFloat(e.target.value);
    if (videoRef.current) videoRef.current.currentTime = time;
    setCurrentTime(time);
  };

  const seekTo = (seconds: number) => {
    if (videoRef.current) {
      videoRef.current.currentTime = seconds;
      setCurrentTime(seconds);
    }
  };

  const handleSegmentClick = (segment: TranscriptSegment) => {
    seekTo(segment.start_ms / 1000);
  };

  const handleSegmentEdit = (id: number, newText: string) => {
    setSegments((prev) =>
      prev.map((seg) => (seg.id === id ? { ...seg, text: newText } : seg))
    );
  };

  const handleSaveTranscript = async () => {
    if (!jwt) return;
    try {
      await apiFetch(`${apiUrl}/tasks/${taskId}/transcript/segments`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ segments }),
      });
    } catch (error) {
      console.error("Failed to save transcript:", error);
    }
  };

  const handleSetExactClipTime = async (
    clip: Clip,
    newStartSec: number,
    newEndSec: number
  ) => {
    let validStart = Math.max(0, newStartSec);
    let validEnd = duration > 0 ? Math.min(duration, newEndSec) : newEndSec;

    if (validEnd <= validStart + 2) {
      validEnd = validStart + 2;
    }

    setClips((prev) =>
      prev.map((c) =>
        c.id === clip.id
          ? { ...c, start_time: String(validStart), end_time: String(validEnd), duration: validEnd - validStart }
          : c
      )
    );

    setSavingClipId(clip.id);
    try {
      await apiFetch(`${apiUrl}/tasks/${taskId}/clips/${clip.id}/time`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ start_time: String(validStart), end_time: String(validEnd) }),
      });
    } catch (error) {
      console.error("Failed to update clip time:", error);
    } finally {
      setSavingClipId(null);
    }
  };

  const handleAdjustClipTime = async (
    clip: Clip,
    field: "start" | "end",
    deltaSeconds: number
  ) => {
    const startSec = parseTs(clip.start_time);
    const endSec = parseTs(clip.end_time);

    let newStart = startSec;
    let newEnd = endSec;

    if (field === "start") {
      newStart = Math.max(0, startSec + deltaSeconds);
      // keep at least 2s clip and don't overlap end
      if (newStart >= newEnd - 2) return;
    } else {
      newEnd = endSec + deltaSeconds;
      if (duration > 0) newEnd = Math.min(duration, newEnd);
      // keep at least 2s clip
      if (newEnd <= newStart + 2) return;
    }

    // Optimistic update
    setClips((prev) =>
      prev.map((c) =>
        c.id === clip.id
          ? { ...c, start_time: String(newStart), end_time: String(newEnd), duration: newEnd - newStart }
          : c
      )
    );

    setSavingClipId(clip.id);
    try {
      await apiFetch(`${apiUrl}/tasks/${taskId}/clips/${clip.id}/time`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ start_time: String(newStart), end_time: String(newEnd) }),
      });
    } catch (error) {
      console.error("Failed to update clip time:", error);
    } finally {
      setSavingClipId(null);
    }
  };

  const handleUpdateClipHook = async (clip: Clip, newTitle: string, newHook: string) => {
    setClips((prev) =>
      prev.map((c) =>
        c.id === clip.id ? { ...c, title: newTitle, hook_text: newHook } : c
      )
    );
    setSavingClipId(clip.id);
    try {
      await apiFetch(`${apiUrl}/tasks/${taskId}/clips/${clip.id}/hook`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: newTitle, hook_text: newHook }),
      });
    } catch (error) {
      console.error("Failed to update clip hook:", error);
    } finally {
      setSavingClipId(null);
    }
  };

  const handleGenerateClips = async () => {
    if (!jwt) return;
    setIsGenerating(true);
    try {
      await handleSaveTranscript();
      const response = await apiFetch(`${apiUrl}/tasks/${taskId}/generate-clips`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          transitions_enabled: transitionsEnabled,
          aspect_ratio: aspectRatio,
          subtitle_style: {
            ...subtitleStyle,
            font_family: selectedFont,
            font_color: fontColor,
            highlight_color: highlightColor,
            margin_v_ratio: marginVRatio,
            hook_font_family: hookFont,
            hook_font_color: canvasStyle === "white_card" && hookColor === "#FFFFFF" ? "#000000" : hookColor,
            hook_position: hookPosition,
            hook_font_size: hookFontSize,
            hook_show_bg: canvasStyle === "white_card" ? false : hookShowBg,
            pad_color: canvasStyle === "white_card" ? "#FFFFFF" : padColor,
            canvas_style: canvasStyle,
            stroke_width: 4,
            shadow_opacity: 0.0,
          },
          pycaps_template: selectedStyle,
        }),
      });
      if (response.ok) router.push(`/studio/${taskId}`);
    } catch (error) {
      console.error("Failed to generate clips:", error);
      setIsGenerating(false);
    }
  };

  if (!task) {
    return (
      <AppLayout>
        <div className="flex items-center justify-center h-screen">
          <div className="w-12 h-12 border-4 border-primary border-t-transparent rounded-full animate-spin"></div>
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div className="max-w-[1600px] mx-auto">
        {/* Header */}
        <div className="mb-4 md:mb-6">
          <h1 className="text-xl md:text-2xl font-bold text-white mb-1 md:mb-2">Review & Edit Transcript</h1>
          <p className="text-gray-400">{task.source?.title || "Video Analysis"}</p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 lg:gap-6">
          {/* Left Column - Video Player */}
          <div className="col-span-1 lg:col-span-2 space-y-4 lg:space-y-6">
            {/* Video Player */}
            <div className="glass rounded-2xl p-4 md:p-6">
              {/* Subtitle toggle */}
              <div className="flex items-center justify-between mb-3">
                <span className="text-sm text-gray-400">
                  {assContent ? "Subtitles ready" : "Loading subtitles..."}
                </span>
                <button
                  onClick={() => setShowSubtitles((v) => !v)}
                  className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${showSubtitles ? "bg-primary/20 text-primary" : "bg-muted text-gray-400 hover:text-white"
                    }`}
                >
                  {showSubtitles ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}
                  {showSubtitles ? "Subtitles ON" : "Subtitles OFF"}
                </button>
              </div>

              {/* Player container — relative so SubtitlePreview can overlay */}
              <div className="relative aspect-video bg-black rounded-lg overflow-hidden mb-4">
                {videoSrc ? (
                  <video
                    ref={videoRef}
                    className="w-full h-full object-contain"
                    src={videoSrc}
                    onLoadedMetadata={handleLoadedMetadata}
                    onPlay={() => setIsPlaying(true)}
                    onPause={() => setIsPlaying(false)}
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center">
                    <div className="w-10 h-10 border-4 border-primary border-t-transparent rounded-full animate-spin" />
                  </div>
                )}

                {/* Subtitle overlay */}
                <AssSubtitleRenderer
                  videoElement={videoEl}
                  assContent={assContent}
                  enabled={showSubtitles}
                />

                {/* Ratio crop preview overlay */}
                {(() => {
                  // Player is 16:9. Calculate side-bar widths for each output ratio.
                  // crop_w / player_w = target_ratio / (16/9)
                  const ratioMap: Record<string, number> = {
                    "9:16": (9 / 16) / (16 / 9), // ≈ 31.64 %
                    "1:1": 1 / (16 / 9),  // = 56.25 %
                    "16:9": 1,                     // full width
                  };
                  const cropFrac = ratioMap[aspectRatio] ?? 1;
                  if (cropFrac >= 1) return null;
                  const sideBarPct = ((1 - cropFrac) / 2) * 100;
                  const centerPct = cropFrac * 100;
                  return (
                    <div className="absolute inset-0 pointer-events-none" style={{ zIndex: 5 }}>
                      {/* Left dark bar */}
                      <div
                        className="absolute top-0 left-0 bottom-0 bg-black/55"
                        style={{ width: `${sideBarPct}%` }}
                      />
                      {/* Right dark bar */}
                      <div
                        className="absolute top-0 right-0 bottom-0 bg-black/55"
                        style={{ width: `${sideBarPct}%` }}
                      />
                      {/* Safe-zone border */}
                      <div
                        className="absolute top-0 bottom-0 border-x-2 border-white/30 border-dashed"
                        style={{ left: `${sideBarPct}%`, width: `${centerPct}%` }}
                      />
                      {/* Label */}
                      <div
                        className="absolute top-2 flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold text-white/90 bg-black/50 border border-white/20"
                        style={{ left: `calc(${sideBarPct}% + 6px)` }}
                      >
                        <span>{aspectRatio}</span>
                      </div>
                    </div>
                  );
                })()}

                {/* Play button overlay */}
                {!isPlaying && videoSrc && (
                  <button
                    onClick={handlePlayPause}
                    className="absolute inset-0 flex items-center justify-center"
                    style={{ zIndex: 10 }}
                  >
                    <div className="w-20 h-20 rounded-full bg-gradient-purple flex items-center justify-center glow-purple">
                      <Play className="w-10 h-10 text-white ml-1" fill="currentColor" />
                    </div>
                  </button>
                )}

                {/* Controls overlay */}
                <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent p-4" style={{ zIndex: 10 }}>
                  <div className="flex items-center gap-3 mb-2">
                    <button onClick={handlePlayPause} className="text-white hover:text-primary transition-colors">
                      {isPlaying ? <Pause className="w-5 h-5" /> : <Play className="w-5 h-5" />}
                    </button>
                    <span className="text-white text-sm font-mono">
                      {formatTime(currentTime)} / {formatTime(duration)}
                    </span>
                  </div>
                  <input
                    type="range"
                    min="0"
                    max={duration || 0}
                    step="0.1"
                    value={currentTime}
                    onChange={handleSeek}
                    className="w-full h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer"
                    style={{
                      background: `linear-gradient(to right, #256af4 0%, #256af4 ${(currentTime / (duration || 1)) * 100}%, #374151 ${(currentTime / (duration || 1)) * 100}%, #374151 100%)`,
                    }}
                  />
                </div>
              </div>
            </div>

            {/* Clip Timeline */}
            <div className="glass rounded-2xl p-4 md:p-6">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <div className="w-8 h-8 rounded-lg bg-primary/20 flex items-center justify-center">
                    <Scissors className="w-4 h-4 text-primary" />
                  </div>
                  <h3 className="font-semibold text-white">Clip Timeline</h3>
                </div>
                {clips.length > 0 && (
                  <span className="text-xs font-semibold text-primary px-2 py-1 rounded bg-primary/20">
                    {clips.length} clip{clips.length !== 1 ? "s" : ""}
                  </span>
                )}
              </div>

              {/* Timeline bar */}
              <div className="relative h-10 bg-gray-800 rounded-lg overflow-hidden mb-1">
                {/* Clip blocks */}
                {duration > 0 && clips.map((clip, i) => {
                  const startSec = parseTs(clip.start_time);
                  const endSec = parseTs(clip.end_time);
                  const left = (startSec / duration) * 100;
                  const width = Math.max(((endSec - startSec) / duration) * 100, 0.5);
                  const color = CLIP_COLORS[i % CLIP_COLORS.length];
                  return (
                    <div
                      key={clip.id}
                      className="absolute top-0 bottom-0 cursor-pointer hover:brightness-125 transition-all flex items-center justify-center group"
                      style={{ left: `${left}%`, width: `${width}%`, backgroundColor: color }}
                      onClick={() => seekTo(startSec)}
                      title={`Clip ${i + 1}: ${formatTime(startSec)} → ${formatTime(endSec)}`}
                    >
                      <span className="text-white text-xs font-bold drop-shadow">{i + 1}</span>
                    </div>
                  );
                })}

                {/* Playhead */}
                {duration > 0 && (
                  <div
                    className="absolute top-0 bottom-0 w-0.5 bg-white/90 pointer-events-none z-10"
                    style={{ left: `${(currentTime / duration) * 100}%` }}
                  />
                )}

                {/* Empty state */}
                {clips.length === 0 && (
                  <div className="absolute inset-0 flex items-center justify-center">
                    <span className="text-xs text-gray-500">No clips yet</span>
                  </div>
                )}
              </div>

              {/* Time axis */}
              <div className="flex justify-between text-xs text-gray-500 mb-5 px-0.5">
                <span>00:00</span>
                <span>{formatTime(duration * 0.25)}</span>
                <span>{formatTime(duration * 0.5)}</span>
                <span>{formatTime(duration * 0.75)}</span>
                <span>{formatTime(duration)}</span>
              </div>

              {/* Clip time editor */}
              {clips.length > 0 && (
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <p className="text-xs text-gray-400 uppercase tracking-wide font-semibold">Manual Clip Length & Timing Editor</p>
                    <span className="text-[10px] text-gray-500 font-mono">Type exact start/end sec or use ± controls</span>
                  </div>

                  {clips.map((clip, i) => {
                    const startSec = parseTs(clip.start_time);
                    const endSec = parseTs(clip.end_time);
                    const clipDur = endSec - startSec;
                    const color = CLIP_COLORS[i % CLIP_COLORS.length];
                    const isSaving = savingClipId === clip.id;
                    const isActive = currentTime >= startSec && currentTime <= endSec;

                    return (
                      <div
                        key={clip.id}
                        className={`p-3.5 rounded-xl border transition-all space-y-3 ${isActive
                          ? "border-primary/50 bg-primary/10 glow-purple"
                          : "border-border/60 bg-muted/20 hover:border-border"
                          }`}
                      >
                        {/* Header: Badge + Title + Duration */}
                        <div className="flex items-center justify-between gap-2" onClick={() => seekTo(startSec)}>
                          <div className="flex items-center gap-2">
                            <div
                              className="w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold text-white shrink-0"
                              style={{ backgroundColor: color }}
                            >
                              {i + 1}
                            </div>
                            <span className="text-xs font-bold text-white truncate max-w-[240px]">
                              {clip.title || `Clip #${i + 1}`}
                            </span>
                          </div>
                          <div className="flex items-center gap-2">
                            <span
                              className="text-xs font-mono font-bold px-2 py-0.5 rounded"
                              style={{ color, backgroundColor: `${color}25` }}
                            >
                              {clipDur.toFixed(1)}s
                            </span>
                            {isSaving && (
                              <div className="w-3 h-3 border-2 border-primary border-t-transparent rounded-full animate-spin shrink-0" />
                            )}
                          </div>
                        </div>

                        {/* Timing Controls Grid */}
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3" onClick={(e) => e.stopPropagation()}>
                          {/* Start Time Section */}
                          <div className="bg-slate-900/60 p-2.5 rounded-lg border border-border/40">
                            <div className="flex items-center justify-between mb-1.5">
                              <span className="text-[11px] font-semibold text-gray-400 uppercase">Start Time</span>
                              <span className="text-xs font-mono text-white font-bold">{formatTime(startSec)}</span>
                            </div>

                            <div className="flex items-center gap-1">
                              <button
                                onClick={() => handleAdjustClipTime(clip, "start", -5)}
                                className="px-1.5 py-1 rounded bg-muted/60 hover:bg-muted text-gray-300 hover:text-white text-[11px] font-bold"
                                title="-5 seconds"
                              >
                                -5s
                              </button>
                              <button
                                onClick={() => handleAdjustClipTime(clip, "start", -1)}
                                className="px-1.5 py-1 rounded bg-muted/60 hover:bg-muted text-gray-300 hover:text-white text-[11px] font-bold"
                                title="-1 second"
                              >
                                -1s
                              </button>
                              <input
                                type="number"
                                step="0.1"
                                min={0}
                                max={endSec - 1}
                                value={startSec.toFixed(1)}
                                onChange={(e) => handleSetExactClipTime(clip, parseFloat(e.target.value) || 0, endSec)}
                                className="w-16 bg-input/80 border border-border/60 rounded text-xs font-mono text-center text-white py-1 focus:outline-none focus:ring-1 focus:ring-primary"
                              />
                              <button
                                onClick={() => handleAdjustClipTime(clip, "start", +1)}
                                className="px-1.5 py-1 rounded bg-muted/60 hover:bg-muted text-gray-300 hover:text-white text-[11px] font-bold"
                                title="+1 second"
                              >
                                +1s
                              </button>
                              <button
                                onClick={() => handleAdjustClipTime(clip, "start", +5)}
                                className="px-1.5 py-1 rounded bg-muted/60 hover:bg-muted text-gray-300 hover:text-white text-[11px] font-bold"
                                title="+5 seconds"
                              >
                                +5s
                              </button>
                            </div>
                          </div>

                          {/* End Time Section */}
                          <div className="bg-slate-900/60 p-2.5 rounded-lg border border-border/40">
                            <div className="flex items-center justify-between mb-1.5">
                              <span className="text-[11px] font-semibold text-gray-400 uppercase">End Time</span>
                              <span className="text-xs font-mono text-white font-bold">{formatTime(endSec)}</span>
                            </div>

                            <div className="flex items-center gap-1">
                              <button
                                onClick={() => handleAdjustClipTime(clip, "end", -5)}
                                className="px-1.5 py-1 rounded bg-muted/60 hover:bg-muted text-gray-300 hover:text-white text-[11px] font-bold"
                                title="-5 seconds"
                              >
                                -5s
                              </button>
                              <button
                                onClick={() => handleAdjustClipTime(clip, "end", -1)}
                                className="px-1.5 py-1 rounded bg-muted/60 hover:bg-muted text-gray-300 hover:text-white text-[11px] font-bold"
                                title="-1 second"
                              >
                                -1s
                              </button>
                              <input
                                type="number"
                                step="0.1"
                                min={startSec + 1}
                                max={duration || 3600}
                                value={endSec.toFixed(1)}
                                onChange={(e) => handleSetExactClipTime(clip, startSec, parseFloat(e.target.value) || startSec + 2)}
                                className="w-16 bg-input/80 border border-border/60 rounded text-xs font-mono text-center text-white py-1 focus:outline-none focus:ring-1 focus:ring-primary"
                              />
                              <button
                                onClick={() => handleAdjustClipTime(clip, "end", +1)}
                                className="px-1.5 py-1 rounded bg-muted/60 hover:bg-muted text-gray-300 hover:text-white text-[11px] font-bold"
                                title="+1 second"
                              >
                                +1s
                              </button>
                              <button
                                onClick={() => handleAdjustClipTime(clip, "end", +5)}
                                className="px-1.5 py-1 rounded bg-muted/60 hover:bg-muted text-gray-300 hover:text-white text-[11px] font-bold"
                                title="+5 seconds"
                              >
                                +5s
                              </button>
                            </div>
                          </div>
                        </div>

                        {/* On-Screen Hype Header Section */}
                        <div className="bg-slate-900/60 p-3 rounded-lg border border-primary/30 space-y-2" onClick={(e) => e.stopPropagation()}>
                          <div className="flex items-center justify-between">
                            <span className="text-[11px] font-bold text-primary uppercase tracking-wide flex items-center gap-1.5">
                              <Sparkles className="w-3.5 h-3.5" />
                              On-Screen Hype Hook Text
                            </span>
                            <span className="text-[10px] text-gray-400">Burns top of video</span>
                          </div>
                          <input
                            type="text"
                            value={clip.hook_text || clip.title || ""}
                            placeholder="e.g. You need to watch this ASAP 🚨"
                            onChange={(e) => handleUpdateClipHook(clip, clip.title || e.target.value, e.target.value)}
                            className="w-full bg-input/90 border border-border/80 rounded-lg text-xs font-semibold text-white px-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-primary"
                          />
                          <div className="flex items-center gap-1.5 flex-wrap pt-0.5">
                            <span className="text-[10px] text-gray-500 font-medium">Quick Hype Ideas:</span>
                            {[
                              "You need to watch this ASAP 🚨",
                              "This is the best drama series I've seen in a long time",
                              "New series alert 🚨",
                              "Wait till the end... 😱",
                              "Insane plot twist 🤯",
                            ].map((preset) => (
                              <button
                                key={preset}
                                onClick={() => handleUpdateClipHook(clip, preset, preset)}
                                className="text-[10px] bg-primary/10 hover:bg-primary/25 border border-primary/30 text-primary-foreground px-2 py-0.5 rounded-full transition-all cursor-pointer"
                              >
                                {`+ "${preset.length > 30 ? preset.slice(0, 30) + "…" : preset}"`}
                              </button>
                            ))}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Action Buttons */}
            <div className="flex items-center gap-4">
              <button
                onClick={handleGenerateClips}
                disabled={isGenerating}
                className="flex-1 h-12 md:h-14 rounded-xl bg-gradient-purple hover:bg-gradient-purple-hover disabled:opacity-50 text-white font-bold text-base md:text-lg transition-all glow-purple flex items-center justify-center gap-2"
              >
                {isGenerating ? (
                  <>
                    <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    Generating Clips...
                  </>
                ) : (
                  <>
                    <Check className="w-5 h-5" />
                    Generate Clips
                  </>
                )}
              </button>
            </div>
          </div>

          {/* Right Column */}
          <div className="space-y-4 md:space-y-6">
            {/* Tabs */}
            <div className="flex gap-2 border-b border-border">
              <button
                onClick={() => setActiveTab("insights")}
                className={`px-6 py-3 font-semibold transition-colors relative ${activeTab === "insights" ? "text-primary" : "text-gray-400 hover:text-white"
                  }`}
              >
                AI Insights
                {activeTab === "insights" && <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary" />}
              </button>
              <button
                onClick={() => setActiveTab("transcript")}
                className={`px-6 py-3 font-semibold transition-colors relative ${activeTab === "transcript" ? "text-primary" : "text-gray-400 hover:text-white"
                  }`}
              >
                Transcript
                {activeTab === "transcript" && <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary" />}
              </button>
            </div>

            {/* Transcript Panel */}
            {activeTab === "transcript" && (
              <div className="glass rounded-2xl p-4 md:p-6">
                <h3 className="font-semibold text-white uppercase tracking-wide mb-4">Transcript</h3>
                <div className="space-y-3 max-h-[400px] overflow-y-auto pr-2">
                  {segments.map((segment) => {
                    const isActive =
                      currentTime * 1000 >= segment.start_ms &&
                      currentTime * 1000 <= segment.end_ms;
                    return (
                      <div
                        key={segment.id}
                        onClick={() => handleSegmentClick(segment)}
                        className={`group cursor-pointer rounded-lg transition-colors ${isActive ? "bg-primary/20" : "hover:bg-muted/50"}`}
                      >
                        <div className="flex items-start gap-3 p-3">
                          <span className={`text-xs font-mono font-semibold mt-1 min-w-[45px] ${isActive ? "text-primary" : "text-primary/70"}`}>
                            {segment.start_time}
                          </span>
                          <textarea
                            value={segment.text}
                            onChange={(e) => handleSegmentEdit(segment.id, e.target.value)}
                            onBlur={handleSaveTranscript}
                            onClick={(e) => e.stopPropagation()}
                            dir={isRTL(segment.text) ? "rtl" : "ltr"}
                            className={`flex-1 text-sm bg-transparent border-none outline-none resize-none transition-colors ${isActive ? "text-white font-medium" : "text-gray-300 group-hover:text-white"} ${isRTL(segment.text) ? "text-right" : "text-left"}`}
                            rows={Math.ceil(segment.text.length / 50)}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Font Family Selection — Select any available font on Teek */}
            <div className="glass rounded-2xl p-4 md:p-6">
              <h3 className="font-semibold text-white uppercase tracking-wide mb-4">Font Family</h3>

              <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
                {AVAILABLE_FONTS_LIST.map((font) => (
                  <button
                    key={font.value}
                    onClick={() => setSelectedFont(font.value)}
                    className={`w-full text-left px-4 py-3 rounded-xl border-2 transition-all ${selectedFont === font.value
                      ? "border-primary bg-primary/10 glow-purple"
                      : "border-border hover:border-primary/50"
                      }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-bold text-white uppercase tracking-wide">
                        {font.name}
                      </span>
                      {font.is_default && (
                        <span className="text-[10px] font-semibold text-primary/70 border border-primary/30 px-1.5 py-0.5 rounded">
                          Default
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-gray-400 mt-0.5 truncate">{font.category}</p>
                  </button>
                ))}
              </div>

              {/* Base Font Color & Target Highlight Color */}
              <div className="mt-5 pt-4 border-t border-border/40 space-y-4">
                {/* Base Text Color */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <label className="text-xs font-semibold text-gray-400 uppercase tracking-wide">
                      Base Text Color
                    </label>
                    <span className="text-xs font-mono font-bold text-white bg-primary/20 px-2 py-0.5 rounded" style={{ color: fontColor }}>
                      {fontColor.toUpperCase()}
                    </span>
                  </div>

                  {/* Swatches */}
                  <div className="flex flex-wrap items-center gap-2 mb-2">
                    {[
                      { name: "White", hex: "#FFFFFF" },
                      { name: "Yellow", hex: "#FFFF00" },
                      { name: "Neon Green", hex: "#00FF00" },
                      { name: "Cyan", hex: "#00FFFF" },
                      { name: "Magenta", hex: "#FF00FF" },
                      { name: "Electric Blue", hex: "#256AF4" },
                      { name: "Bright Red", hex: "#FF2A2A" },
                      { name: "Orange", hex: "#FF5722" },
                      { name: "Purple", hex: "#9333EA" },
                      { name: "Gold", hex: "#FFD700" },
                      { name: "Hot Pink", hex: "#FF69B4" },
                      { name: "Lime", hex: "#32CD32" },
                    ].map((c) => (
                      <button
                        key={c.hex}
                        onClick={() => setFontColor(c.hex)}
                        title={c.name}
                        className={`w-6 h-6 rounded-full border-2 transition-transform ${fontColor.toUpperCase() === c.hex ? "scale-125 border-white ring-2 ring-primary z-10" : "border-black/30 hover:scale-110"
                          }`}
                        style={{ backgroundColor: c.hex }}
                      />
                    ))}
                  </div>

                  {/* Custom Color Spectrum Picker */}
                  <div className="flex items-center gap-2 bg-slate-900/60 p-2 rounded-xl border border-border/40">
                    <span className="text-[11px] text-gray-400 font-semibold uppercase">Custom Color:</span>
                    <input
                      type="color"
                      value={fontColor.startsWith("#") && fontColor.length === 7 ? fontColor : "#FFFFFF"}
                      onChange={(e) => setFontColor(e.target.value)}
                      className="w-7 h-7 rounded border-none cursor-pointer bg-transparent"
                    />
                    <input
                      type="text"
                      value={fontColor}
                      onChange={(e) => setFontColor(e.target.value)}
                      placeholder="#FFFFFF"
                      className="flex-1 bg-input/80 border border-border/60 rounded-lg text-xs font-mono text-white px-2.5 py-1 uppercase focus:outline-none focus:ring-1 focus:ring-primary"
                      maxLength={7}
                    />
                  </div>
                </div>

                {/* Target Highlight Color */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <label className="text-xs font-semibold text-gray-400 uppercase tracking-wide">
                      Target Word Highlight
                    </label>
                    <span className="text-xs font-mono font-bold text-white bg-primary/20 px-2 py-0.5 rounded" style={{ color: highlightColor }}>
                      {highlightColor.toUpperCase()}
                    </span>
                  </div>

                  {/* Swatches */}
                  <div className="flex flex-wrap items-center gap-2 mb-2">
                    {[
                      { name: "Pure Yellow", hex: "#FFFF00" },
                      { name: "Neon Green", hex: "#00FF00" },
                      { name: "Electric Cyan", hex: "#00FFFF" },
                      { name: "Hot Pink", hex: "#FF007F" },
                      { name: "Bright Orange", hex: "#FF6600" },
                      { name: "Vivid Red", hex: "#FF0000" },
                      { name: "Violet", hex: "#8A2BE2" },
                      { name: "Lime", hex: "#7FFF00" },
                      { name: "Pure White", hex: "#FFFFFF" },
                    ].map((c) => (
                      <button
                        key={c.hex}
                        onClick={() => setHighlightColor(c.hex)}
                        title={c.name}
                        className={`w-6 h-6 rounded-full border-2 transition-transform ${highlightColor.toUpperCase() === c.hex ? "scale-125 border-white ring-2 ring-primary z-10" : "border-black/30 hover:scale-110"
                          }`}
                        style={{ backgroundColor: c.hex }}
                      />
                    ))}
                  </div>

                  {/* Custom Spectrum Color Picker */}
                  <div className="flex items-center gap-2 bg-slate-900/60 p-2 rounded-xl border border-border/40">
                    <span className="text-[11px] text-gray-400 font-semibold uppercase">Custom Highlight:</span>
                    <input
                      type="color"
                      value={highlightColor.startsWith("#") && highlightColor.length === 7 ? highlightColor : "#FFFF00"}
                      onChange={(e) => setHighlightColor(e.target.value)}
                      className="w-7 h-7 rounded border-none cursor-pointer bg-transparent"
                    />
                    <input
                      type="text"
                      value={highlightColor}
                      onChange={(e) => setHighlightColor(e.target.value)}
                      placeholder="#FFFF00"
                      className="flex-1 bg-input/80 border border-border/60 rounded-lg text-xs font-mono text-white px-2.5 py-1 uppercase focus:outline-none focus:ring-1 focus:ring-primary"
                      maxLength={7}
                    />
                  </div>
                </div>

                {/* Font Size Slider */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs text-gray-400 font-semibold uppercase tracking-wide">Font Size</span>
                    <span className="text-xs font-mono font-bold text-white bg-primary/20 px-2 py-0.5 rounded">
                      {subtitleStyle.font_size}px
                    </span>
                  </div>
                  <input
                    type="range"
                    min={16}
                    max={56}
                    step={2}
                    value={subtitleStyle.font_size}
                    onChange={(e) => setSubtitleStyle({ font_size: parseInt(e.target.value) })}
                    className="w-full h-2 rounded-lg appearance-none cursor-pointer"
                    style={{
                      background: `linear-gradient(to right, #256af4 0%, #256af4 ${((subtitleStyle.font_size - 16) / 40) * 100}%, #374151 ${((subtitleStyle.font_size - 16) / 40) * 100}%, #374151 100%)`,
                    }}
                  />
                  <div className="flex justify-between text-[10px] text-gray-600 mt-1">
                    <span>16</span>
                    <span>56</span>
                  </div>
                </div>

                {/* Caption Location / Vertical Position */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs text-gray-400 font-semibold uppercase tracking-wide">Caption Position</span>
                    <span className="text-xs font-mono font-bold text-white bg-primary/20 px-2 py-0.5 rounded">
                      {Math.round(marginVRatio * 100)}%
                    </span>
                  </div>

                  {/* Position Quick Presets */}
                  <div className="grid grid-cols-3 gap-1.5 mb-2.5">
                    {[
                      { name: "Bottom", ratio: 0.15 },
                      { name: "Center", ratio: 0.42 },
                      { name: "Top", ratio: 0.70 },
                    ].map((p) => (
                      <button
                        key={p.name}
                        onClick={() => setMarginVRatio(p.ratio)}
                        className={`text-xs font-bold py-1.5 px-2 rounded-lg border transition-all ${Math.abs(marginVRatio - p.ratio) < 0.05
                          ? "border-primary bg-primary text-white glow-purple"
                          : "border-border/60 bg-muted/30 text-gray-300 hover:border-primary/50 hover:text-white"
                          }`}
                      >
                        {p.name}
                      </button>
                    ))}
                  </div>

                  {/* Vertical Position Slider */}
                  <input
                    type="range"
                    min={10}
                    max={80}
                    step={1}
                    value={Math.round(marginVRatio * 100)}
                    onChange={(e) => setMarginVRatio(parseInt(e.target.value) / 100)}
                    className="w-full h-2 rounded-lg appearance-none cursor-pointer"
                    style={{
                      background: `linear-gradient(to right, #256af4 0%, #256af4 ${((marginVRatio * 100 - 10) / 70) * 100}%, #374151 ${((marginVRatio * 100 - 10) / 70) * 100}%, #374151 100%)`,
                    }}
                  />
                  <div className="flex justify-between text-[10px] text-gray-600 mt-1">
                    <span>Bottom (10%)</span>
                    <span>Top (80%)</span>
                  </div>
                </div>

                {/* On-Screen Hype Text Styling Controls (Font, Color, Position, Box) */}
                <div className="pt-4 border-t border-border/60 space-y-4">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-primary uppercase tracking-wide flex items-center gap-1.5">
                      <Sparkles className="w-3.5 h-3.5" />
                      On-Screen Text Style & Position
                    </span>
                    <button
                      type="button"
                      onClick={() => setHookShowBg((prev) => !prev)}
                      className={`text-[10px] font-bold px-2 py-0.5 rounded-full border transition-all ${hookShowBg ? "bg-primary/20 border-primary text-primary" : "bg-muted/40 border-border/60 text-gray-400"
                        }`}
                    >
                      {hookShowBg ? "Dark Box: ON" : "Dark Box: OFF"}
                    </button>
                  </div>

                  {/* Hook Position Presets */}
                  <div>
                    <span className="text-[11px] text-gray-400 font-semibold uppercase tracking-wide block mb-1.5">Text Position</span>
                    <div className="grid grid-cols-3 gap-1.5">
                      {[
                        { id: "top", label: "Top" },
                        { id: "center", label: "Center" },
                        { id: "bottom", label: "Bottom" },
                      ].map((pos) => (
                        <button
                          key={pos.id}
                          type="button"
                          onClick={() => setHookPosition(pos.id as "top" | "center" | "bottom")}
                          className={`text-xs font-bold py-1.5 px-2 rounded-lg border transition-all ${hookPosition === pos.id
                            ? "border-primary bg-primary text-white glow-purple"
                            : "border-border/60 bg-muted/30 text-gray-300 hover:border-primary/50 hover:text-white"
                            }`}
                        >
                          {pos.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Hook Font Family Dropdown */}
                  <div>
                    <span className="text-[11px] text-gray-400 font-semibold uppercase tracking-wide block mb-1.5">Text Font</span>
                    <select
                      value={hookFont}
                      onChange={(e) => setHookFont(e.target.value)}
                      className="w-full bg-input/90 border border-border/80 rounded-lg text-xs font-bold text-white px-3 py-2 focus:outline-none focus:ring-1 focus:ring-primary"
                    >
                      {AVAILABLE_FONTS_LIST.map((f) => (
                        <option key={f.value} value={f.value} className="bg-slate-900 text-white font-sans">
                          {f.name}
                        </option>
                      ))}
                    </select>
                  </div>

                  {/* Hook Text Color Selector */}
                  <div>
                    <div className="flex items-center justify-between mb-1.5">
                      <span className="text-[11px] text-gray-400 font-semibold uppercase tracking-wide">Text Color</span>
                      <span className="text-xs font-mono font-bold text-white uppercase">{hookColor}</span>
                    </div>
                    <div className="flex items-center gap-1.5 flex-wrap mb-2">
                      {[
                        { name: "Pure White", hex: "#FFFFFF" },
                        { name: "Neon Yellow", hex: "#FFFF00" },
                        { name: "Cyan", hex: "#00FFFF" },
                        { name: "Vibrant Red", hex: "#FF0000" },
                        { name: "Lime Green", hex: "#7FFF00" },
                        { name: "Hot Pink", hex: "#FF69B4" },
                        { name: "Gold", hex: "#FFD700" },
                        { name: "Orange", hex: "#FF8C00" },
                        { name: "Purple", hex: "#A855F7" },
                        { name: "Blue", hex: "#3B82F6" },
                      ].map((c) => (
                        <button
                          key={c.hex}
                          type="button"
                          onClick={() => setHookColor(c.hex)}
                          title={c.name}
                          className={`w-6 h-6 rounded-full border-2 transition-transform ${hookColor.toUpperCase() === c.hex ? "scale-125 border-white ring-2 ring-primary z-10" : "border-black/30 hover:scale-110"
                            }`}
                          style={{ backgroundColor: c.hex }}
                        />
                      ))}
                    </div>
                    <div className="flex items-center gap-2 bg-slate-900/60 p-2 rounded-xl border border-border/40">
                      <span className="text-[10px] text-gray-400 font-semibold uppercase">Custom:</span>
                      <input
                        type="color"
                        value={hookColor.startsWith("#") && hookColor.length === 7 ? hookColor : "#FFFFFF"}
                        onChange={(e) => setHookColor(e.target.value)}
                        className="w-6 h-6 rounded border-none cursor-pointer bg-transparent"
                      />
                      <input
                        type="text"
                        value={hookColor}
                        onChange={(e) => setHookColor(e.target.value)}
                        placeholder="#FFFFFF"
                        className="flex-1 bg-input/80 border border-border/60 rounded-lg text-xs font-mono text-white px-2 py-0.5 uppercase focus:outline-none focus:ring-1 focus:ring-primary"
                        maxLength={7}
                      />
                    </div>
                  </div>

                  {/* Hook Font Size Slider */}
                  <div>
                    <div className="flex items-center justify-between mb-1.5">
                      <span className="text-[11px] text-gray-400 font-semibold uppercase tracking-wide">Text Size</span>
                      <span className="text-xs font-mono font-bold text-white bg-primary/20 px-2 py-0.5 rounded">
                        {hookFontSize}px
                      </span>
                    </div>
                    <input
                      type="range"
                      min={16}
                      max={48}
                      step={2}
                      value={hookFontSize}
                      onChange={(e) => setHookFontSize(parseInt(e.target.value))}
                      className="w-full h-2 rounded-lg appearance-none cursor-pointer"
                      style={{
                        background: `linear-gradient(to right, #256af4 0%, #256af4 ${((hookFontSize - 16) / 32) * 100}%, #374151 ${((hookFontSize - 16) / 32) * 100}%, #374151 100%)`,
                      }}
                    />
                    <div className="flex justify-between text-[10px] text-gray-600 mt-1">
                      <span>16px</span>
                      <span>48px</span>
                    </div>
                  </div>
                </div>
              </div>

              <p className="text-xs text-gray-500 mt-3">
                Select a font, colors, and vertical position to preview live on the video above.
              </p>
            </div>

            {/* Canvas Frame & Background Padding (White Card vs Dark) */}
            <div className="glass rounded-2xl p-4 md:p-6">
              <h3 className="font-semibold text-white uppercase tracking-wide mb-4">Canvas Frame & Background</h3>
              <div className="grid grid-cols-2 gap-3 mb-3">
                <button
                  type="button"
                  onClick={() => { setCanvasStyle("white_card"); setPadColor("#FFFFFF"); }}
                  className={`p-3 rounded-xl border-2 transition-all flex flex-col items-center gap-2 ${canvasStyle === "white_card"
                    ? "border-primary bg-primary/10 glow-purple"
                    : "border-border/60 bg-muted/20 hover:border-primary/50"
                    }`}
                >
                  <div className="w-10 h-14 bg-white border border-gray-300 rounded flex flex-col items-center justify-between p-1">
                    <div className="w-full h-2 bg-gray-200 rounded-xs" />
                    <div className="w-full h-8 bg-slate-800 rounded-xs" />
                    <div className="w-full h-2 bg-gray-200 rounded-xs" />
                  </div>
                  <span className="text-xs font-bold text-white">White Card</span>
                  <span className="text-[10px] text-gray-400 text-center">Top/Bottom White Bars</span>
                </button>

                <button
                  type="button"
                  onClick={() => { setCanvasStyle("dark"); setPadColor("#000000"); }}
                  className={`p-3 rounded-xl border-2 transition-all flex flex-col items-center gap-2 ${canvasStyle === "dark"
                    ? "border-primary bg-primary/10 glow-purple"
                    : "border-border/60 bg-muted/20 hover:border-primary/50"
                    }`}
                >
                  <div className="w-10 h-14 bg-black border border-gray-700 rounded flex flex-col items-center justify-between p-1">
                    <div className="w-full h-2 bg-gray-900 rounded-xs" />
                    <div className="w-full h-8 bg-slate-800 rounded-xs" />
                    <div className="w-full h-2 bg-gray-900 rounded-xs" />
                  </div>
                  <span className="text-xs font-bold text-white">Dark Frame</span>
                  <span className="text-[10px] text-gray-400 text-center">Standard Black Canvas</span>
                </button>
              </div>

              {canvasStyle === "custom" && (
                <div className="flex items-center gap-2 bg-slate-900/60 p-2 rounded-xl border border-border/40 mt-2">
                  <span className="text-[11px] text-gray-400 font-semibold uppercase">Canvas Color:</span>
                  <input
                    type="color"
                    value={padColor.startsWith("#") && padColor.length === 7 ? padColor : "#FFFFFF"}
                    onChange={(e) => setPadColor(e.target.value)}
                    className="w-6 h-6 rounded border-none cursor-pointer bg-transparent"
                  />
                  <input
                    type="text"
                    value={padColor}
                    onChange={(e) => setPadColor(e.target.value)}
                    placeholder="#FFFFFF"
                    className="flex-1 bg-input/80 border border-border/60 rounded-lg text-xs font-mono text-white px-2 py-0.5 uppercase focus:outline-none focus:ring-1 focus:ring-primary"
                    maxLength={7}
                  />
                </div>
              )}
            </div>

            {/* Aspect Ratio */}
            <div className="glass rounded-2xl p-4 md:p-6">
              <h3 className="font-semibold text-white uppercase tracking-wide mb-4">Clip Ratio</h3>
              <div className="flex gap-3">
                {(
                  [
                    { value: "9:16", label: "9:16", desc: "Vertical", visual: "h-12 w-7" },
                    { value: "1:1", label: "1:1", desc: "Square", visual: "h-9 w-9" },
                    { value: "16:9", label: "16:9", desc: "Landscape", visual: "h-7 w-12" },
                  ] as const
                ).map(({ value, label, desc, visual }) => (
                  <button
                    key={value}
                    onClick={() => setAspectRatio(value)}
                    className={`flex-1 flex flex-col items-center gap-2 py-3 px-2 rounded-xl border-2 transition-all ${aspectRatio === value
                      ? "border-primary bg-primary/10 glow-purple"
                      : "border-border hover:border-primary/50"
                      }`}
                  >
                    <div
                      className={`${visual} rounded border-2 ${aspectRatio === value ? "border-primary bg-primary/20" : "border-gray-500 bg-muted"
                        }`}
                    />
                    <span className="text-xs font-bold text-white">{label}</span>
                    <span className="text-xs text-gray-400">{desc}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* Transitions Toggle */}
            <div className="glass rounded-2xl p-4 md:p-6">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="font-semibold text-white">Transition Effects</h3>
                  <p className="text-xs text-gray-400 mt-0.5">Add cinematic transitions between clips</p>
                </div>
                <button
                  onClick={() => setTransitionsEnabled((v) => !v)}
                  className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none ${transitionsEnabled ? "bg-primary" : "bg-muted"
                    }`}
                  role="switch"
                  aria-checked={transitionsEnabled}
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${transitionsEnabled ? "translate-x-6" : "translate-x-1"
                      }`}
                  />
                </button>
              </div>
            </div>

            {/* Export Health */}
            <div className="glass rounded-xl p-4">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm text-gray-400 uppercase tracking-wide">Export Health</span>
                <span className="text-sm font-bold text-primary">75%</span>
              </div>
              <div className="h-2 bg-muted rounded-full overflow-hidden">
                <div className="h-full bg-gradient-purple" style={{ width: "75%" }} />
              </div>
            </div>
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
