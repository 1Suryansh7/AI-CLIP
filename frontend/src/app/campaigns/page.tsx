"use client";

import { useState, useEffect, useRef, useMemo } from "react";
import { useJwt } from "@/contexts/jwt-context";
import {
  DollarSign, Plus, RefreshCw, Instagram, FileText, Video, CheckCircle2,
  AlertCircle, Play, Sparkles, Pencil, Download, Eye, ChevronRight, ChevronLeft,
  Zap, Palette, Trash2, Sliders, Type, LayoutGrid
} from "lucide-react";
import { AssSubtitleRenderer } from "@/components/clip/AssSubtitleRenderer";

interface Campaign {
  id: string;
  campaign_name: string;
  google_doc_url?: string;
  drive_url?: string;
  extracted_rules?: string;
  required_bio_text?: string;
  required_bio_link?: string;
  mandatory_tags?: string;
  mandatory_hashtags?: string;
  instagram_username?: string;
  rate_per_1k_views: number;
  status: string;
  clip_mode?: string;
  font_family?: string;
  font_size?: number;
  font_color?: string;
  stroke_color?: string;
  subtitle_template?: string;
  highlight_color?: string;
  margin_v_ratio?: number;
  total_clips: number;
  total_views: number;
  total_estimated_payout: number;
  created_at: string;
}

interface DownloadedVideo {
  url: string;
  local_path: string | null;
  status: string;
  title?: string;
  duration?: number;
  thumbnail?: string;
  error?: string;
}

interface PreviewClipData {
  preview_video_url: string;
  ass_content?: string;
  clip_data: {
    start_time: string;
    end_time: string;
    duration: number;
    text: string;
    hook_text?: string;
    relevance_score: number;
  };
  style: Record<string, any>;
}

interface AutomationProgress {
  progress: number;
  stage: string;
  details: string;
  completed: boolean;
  error?: string | null;
}

const AVAILABLE_FONTS_LIST = [
  { value: "TikTokSans-Regular", name: "TIKTOK SANS", category: "TikTok style caption font" },
  { value: "BurbankBigCondensed-Black", name: "BURBANK BIG CONDENSED", category: "Heavy gaming / viral Shorts font" },
  { value: "Montserrat-ExtraBold", name: "MONTSERRAT EXTRA BOLD", category: "Extra-bold modern sans" },
  { value: "Montserrat-Bold", name: "MONTSERRAT BOLD", category: "Clean subtitle weight" },
  { value: "Montserrat-Regular", name: "MONTSERRAT REGULAR", category: "Standard clean geometric font" },
  { value: "Anton-Regular", name: "ANTON", category: "Impactful condensed headline" },
  { value: "ArchivoBlack-Regular", name: "ARCHIVO BLACK", category: "Heavyweight ultra-bold font" },
  { value: "BebasNeue-Regular", name: "BEBAS NEUE", category: "All-caps display style" },
  { value: "NotoSans-Regular", name: "NOTO SANS", category: "Universal clean readable font" },
  { value: "Poppins-SemiBold", name: "POPPINS SEMIBOLD", category: "Geometric rounded subtitle font" },
  { value: "THEBOLDFONT-FREEVERSION", name: "THE BOLD FONT", category: "High-energy bold caps" },
  { value: "Inter-Variable", name: "INTER", category: "Modern interface subtitle style" },
  { value: "Lato-Bold", name: "LATO BOLD", category: "Warm legible bold font" },
  { value: "OpenSans-Variable", name: "OPEN SANS", category: "Neutral highly legible style" },
  { value: "Oswald-Variable", name: "OSWALD", category: "Narrow condensed font" },
  { value: "Roboto-Variable", name: "ROBOTO", category: "Classic balanced subtitle font" },
];

const TEMPLATES = [
  { value: "word-focus", name: "Word Focus", desc: "Highlights active spoken word" },
  { value: "karaoke", name: "Karaoke", desc: "Color fill word by word" },
  { value: "bounce", name: "Bounce", desc: "Active word bounces on speak" },
  { value: "explosive", name: "Explosive", desc: "Word scales up smoothly" },
  { value: "glow", name: "Glow", desc: "Active word text glow" },
];

function applyFontSizeToAss(ass: string, newSize: number): string {
  const match = ass.match(/^Style: Default,[^,]+,(\d+)/m);
  if (!match) return ass;
  const oldSize = parseInt(match[1]);
  if (oldSize === newSize) return ass;
  let result = ass.replace(/(^Style: Default,[^,]+,)\d+/m, `$1${newSize}`);
  result = result.replace(/\\fs(\d+)/g, (_, n) => `\\fs${Math.round(parseInt(n) * newSize / oldSize)}`);
  return result;
}

export default function WhopCampaignsPage() {
  const { apiFetch, jwt } = useJwt();
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [syncingId, setSyncingId] = useState<string | null>(null);
  const [editingCampaign, setEditingCampaign] = useState<Campaign | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // Automation Progress Tracking state
  const [activeAutomationId, setActiveAutomationId] = useState<string | null>(null);
  const [automationProgress, setAutomationProgress] = useState<AutomationProgress | null>(null);
  const progressPollRef = useRef<NodeJS.Timeout | null>(null);

  // Wizard state
  const [wizardStep, setWizardStep] = useState(1);

  // Form State (Complete Review Page parity)
  const [formData, setFormData] = useState({
    campaign_name: "",
    google_doc_url: "",
    drive_url: "",
    required_bio_text: "",
    required_bio_link: "",
    mandatory_tags: "",
    mandatory_hashtags: "",
    caption_instructions: "",
    instagram_username: "",
    instagram_password: "",
    rate_per_1k_views: "3.50",
    clip_mode: "highlights",
    font_family: "TikTokSans-Regular",
    font_size: "24",
    font_color: "#FFFFFF",
    stroke_color: "#000000",
    subtitle_template: "word-focus",
    highlight_color: "#FFFF00",
    margin_v_ratio: "0.42",
    hook_text: "Viral Highlight",
    hook_font_family: "BurbankBigCondensed-Black",
    hook_font_color: "#FFFFFF",
    hook_position: "top",
    hook_font_size: "26",
    hook_show_bg: true,
    aspect_ratio: "9:16",
    transitions_enabled: false,
  });

  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");

  // Step 2: Download state
  const [downloadedVideos, setDownloadedVideos] = useState<DownloadedVideo[]>([]);
  const [isDownloading, setIsDownloading] = useState(false);
  const [savedCampaignId, setSavedCampaignId] = useState<string | null>(null);

  // Step 3: Preview clip state
  const [previewClip, setPreviewClip] = useState<PreviewClipData | null>(null);
  const [isGeneratingPreview, setIsGeneratingPreview] = useState(false);
  const [isRunningAutomation, setIsRunningAutomation] = useState(false);

  const previewVideoRef = useRef<HTMLVideoElement>(null);
  const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null);

  const apiUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

  const fetchCampaigns = async () => {
    setLoading(true);
    try {
      const res = await apiFetch(`${apiUrl}/campaigns`);
      if (res.ok) {
        const data = await res.json();
        setCampaigns(data);
      }
    } catch (err) {
      console.error("Failed to load campaigns", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (jwt) {
      fetchCampaigns();
    }
  }, [jwt]);

  // Poll automation progress if active
  useEffect(() => {
    if (!activeAutomationId) {
      if (progressPollRef.current) clearInterval(progressPollRef.current);
      return;
    }

    const pollStatus = async () => {
      try {
        const res = await apiFetch(`${apiUrl}/campaigns/${activeAutomationId}/automation-status`);
        if (res.ok) {
          const statusData: AutomationProgress = await res.json();
          setAutomationProgress(statusData);
          if (statusData.completed) {
            if (progressPollRef.current) clearInterval(progressPollRef.current);
            fetchCampaigns();
          }
        }
      } catch (err) {
        console.error("Error polling automation status:", err);
      }
    };

    pollStatus();
    progressPollRef.current = setInterval(pollStatus, 1500);

    return () => {
      if (progressPollRef.current) clearInterval(progressPollRef.current);
    };
  }, [activeAutomationId]);

  const liveAssContent = useMemo(() => {
    if (!previewClip?.ass_content) return null;
    return applyFontSizeToAss(previewClip.ass_content, parseInt(formData.font_size) || 24);
  }, [previewClip?.ass_content, formData.font_size]);

  const fetchDownloadedVideos = async (campaignId: string) => {
    if (!campaignId) return;
    try {
      const res = await apiFetch(`${apiUrl}/campaigns/${campaignId}/download-videos`, {
        method: "POST",
      });
      if (res.ok) {
        const data = await res.json();
        setDownloadedVideos(data.videos || []);
      }
    } catch (err) {
      console.error("Failed to fetch downloaded videos", err);
    }
  };

  const handleDeleteCampaign = async (id: string, name: string) => {
    if (!confirm(`Are you sure you want to delete campaign '${name}' and all its associated clips?`)) {
      return;
    }
    setDeletingId(id);
    try {
      const res = await apiFetch(`${apiUrl}/campaigns/${id}`, { method: "DELETE" });
      if (res.ok) {
        fetchCampaigns();
      }
    } catch (err) {
      console.error("Delete campaign failed", err);
    } finally {
      setDeletingId(null);
    }
  };

  const handleDeleteDownloadedVideo = async (videoPathOrUrl: string | null) => {
    if (!videoPathOrUrl || !savedCampaignId) return;
    try {
      const res = await apiFetch(`${apiUrl}/campaigns/${savedCampaignId}/delete-video`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ video_path_or_url: videoPathOrUrl }),
      });
      if (res.ok) {
        setDownloadedVideos((prev) => prev.filter((v) => v.url !== videoPathOrUrl && v.local_path !== videoPathOrUrl));
        fetchCampaigns();
      }
    } catch (err) {
      console.error("Failed to delete video source", err);
    }
  };

  const handleAutoUploadFiles = async (files: File[]) => {
    if (!files.length) return;
    let targetCampaignId = savedCampaignId;

    if (!targetCampaignId) {
      try {
        const createRes = await apiFetch(`${apiUrl}/campaigns`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            campaign_name: formData.campaign_name || "New Whop Campaign",
            google_doc_url: formData.google_doc_url,
            drive_url: formData.drive_url,
            instagram_username: formData.instagram_username || "sher.clips",
            rate_per_1k_views: parseFloat(formData.rate_per_1k_views) || 3.5,
          }),
        });
        if (createRes.ok) {
          const newCamp = await createRes.json();
          targetCampaignId = newCamp.id;
          setSavedCampaignId(newCamp.id);
        } else {
          setErrorMsg("Please save Campaign Details in Step 1 first.");
          return;
        }
      } catch (err: any) {
        setErrorMsg("Failed to auto-save campaign for video upload.");
        return;
      }
    }

    setIsDownloading(true);
    setErrorMsg("");
    try {
      const fileData = new FormData();
      files.forEach((f) => fileData.append("files", f));
      const res = await apiFetch(`${apiUrl}/campaigns/${targetCampaignId}/upload-videos`, {
        method: "POST",
        body: fileData,
      });
      if (res.ok) {
        const data = await res.json();
        if (data.videos) {
          setDownloadedVideos((prev) => {
            const existingPaths = new Set(prev.map((v) => v.local_path || v.url));
            const newVids = data.videos.filter((v: any) => !existingPaths.has(v.local_path || v.url));
            return [...prev, ...newVids];
          });
        }
        setSelectedFiles([]);
      } else {
        const errText = await res.text();
        setErrorMsg(`Upload failed: ${errText}`);
      }
    } catch (err: any) {
      setErrorMsg(`Upload failed: ${err.message}`);
    } finally {
      setIsDownloading(false);
    }
  };

  const openCreateModal = () => {
    setEditingCampaign(null);
    setWizardStep(1);
    setFormData({
      campaign_name: "",
      google_doc_url: "",
      drive_url: "",
      required_bio_text: "",
      required_bio_link: "",
      mandatory_tags: "",
      mandatory_hashtags: "",
      caption_instructions: "",
      instagram_username: "",
      instagram_password: "",
      rate_per_1k_views: "3.50",
      clip_mode: "highlights",
      font_family: "TikTokSans-Regular",
      font_size: "24",
      font_color: "#FFFFFF",
      stroke_color: "#000000",
      subtitle_template: "word-focus",
      highlight_color: "#FFFF00",
      margin_v_ratio: "0.42",
      hook_text: "Viral Highlight",
      hook_font_family: "BurbankBigCondensed-Black",
      hook_font_color: "#FFFFFF",
      hook_position: "top",
      hook_font_size: "26",
      hook_show_bg: true,
      aspect_ratio: "9:16",
      transitions_enabled: false,
    });
    setSelectedFiles([]);
    setDownloadedVideos([]);
    setPreviewClip(null);
    setSavedCampaignId(null);
    setErrorMsg("");
    setShowModal(true);
  };

  const openEditModal = (c: Campaign) => {
    setEditingCampaign(c);
    setWizardStep(1);
    setFormData({
      campaign_name: c.campaign_name || "",
      google_doc_url: c.google_doc_url || "",
      drive_url: c.drive_url || "",
      required_bio_text: c.required_bio_text || "",
      required_bio_link: c.required_bio_link || "",
      mandatory_tags: c.mandatory_tags || "",
      mandatory_hashtags: c.mandatory_hashtags || "",
      caption_instructions: "",
      instagram_username: c.instagram_username || "",
      instagram_password: "",
      rate_per_1k_views: (c.rate_per_1k_views || 3.5).toString(),
      clip_mode: c.clip_mode || "highlights",
      font_family: c.font_family || "TikTokSans-Regular",
      font_size: (c.font_size || 24).toString(),
      font_color: c.font_color || "#FFFFFF",
      stroke_color: c.stroke_color || "#000000",
      subtitle_template: c.subtitle_template || "word-focus",
      highlight_color: c.highlight_color || "#FFFF00",
      margin_v_ratio: (c.margin_v_ratio || 0.42).toString(),
      hook_text: "Viral Highlight",
      hook_font_family: "BurbankBigCondensed-Black",
      hook_font_color: "#FFFFFF",
      hook_position: "top",
      hook_font_size: "26",
      hook_show_bg: true,
      aspect_ratio: "9:16",
      transitions_enabled: false,
    });
    setSelectedFiles([]);
    setDownloadedVideos([]);
    setPreviewClip(null);
    setSavedCampaignId(c.id);
    setErrorMsg("");
    setShowModal(true);

    if (c.id) {
      fetchDownloadedVideos(c.id);
    }
  };

  const handleSaveCampaignDetails = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setErrorMsg("");

    const targetUrl = editingCampaign
      ? `${apiUrl}/campaigns/${editingCampaign.id}`
      : `${apiUrl}/campaigns`;
    const targetMethod = editingCampaign ? "PUT" : "POST";

    try {
      const res = await apiFetch(targetUrl, {
        method: targetMethod,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...formData,
          rate_per_1k_views: parseFloat(formData.rate_per_1k_views) || 3.5,
          font_size: parseInt(formData.font_size) || 24,
          margin_v_ratio: parseFloat(formData.margin_v_ratio) || 0.42,
        }),
      });

      if (!res.ok) {
        let errorText = "Failed to save campaign";
        const rawBody = await res.text();
        try {
          const err = JSON.parse(rawBody);
          errorText = err.detail || errorText;
        } catch {
          errorText = rawBody || errorText;
        }
        throw new Error(errorText);
      }

      const savedCampaign = await res.json();
      setSavedCampaignId(savedCampaign.id);

      if (selectedFiles.length > 0) {
        await handleAutoUploadFiles(selectedFiles);
      } else {
        await fetchDownloadedVideos(savedCampaign.id);
      }

      setWizardStep(2);
      fetchCampaigns();
    } catch (err: any) {
      setErrorMsg(err.message || "An error occurred");
    } finally {
      setSubmitting(false);
    }
  };

  const handleDownloadVideos = async () => {
    if (!savedCampaignId) return;
    setIsDownloading(true);
    setErrorMsg("");

    try {
      if (selectedFiles.length > 0) {
        await handleAutoUploadFiles(selectedFiles);
      }

      const res = await apiFetch(`${apiUrl}/campaigns/${savedCampaignId}/download-videos`, {
        method: "POST",
      });

      if (!res.ok) {
        const rawBody = await res.text();
        try {
          const err = JSON.parse(rawBody);
          throw new Error(err.detail || "Download failed");
        } catch {
          throw new Error(rawBody || "Download failed");
        }
      }

      const data = await res.json();
      setDownloadedVideos(data.videos || []);

      if (data.downloaded_count > 0) {
        setWizardStep(3);
      }
    } catch (err: any) {
      setErrorMsg(err.message || "Video download failed");
    } finally {
      setIsDownloading(false);
    }
  };

  const handleGeneratePreview = async () => {
    if (!savedCampaignId) return;
    setIsGeneratingPreview(true);
    setErrorMsg("");

    const firstVideo = downloadedVideos.find((v) => v.status === "downloaded" && v.local_path);

    try {
      const res = await apiFetch(`${apiUrl}/campaigns/${savedCampaignId}/generate-preview-clip`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          video_path: firstVideo ? firstVideo.local_path : null,
          subtitle_template: formData.subtitle_template,
          font_family: formData.font_family,
          font_size: parseInt(formData.font_size) || 24,
          font_color: formData.font_color,
          highlight_color: formData.highlight_color,
          stroke_color: formData.stroke_color,
          margin_v_ratio: parseFloat(formData.margin_v_ratio) || 0.42,
          hook_text: formData.hook_text,
          hook_font_family: formData.hook_font_family,
          hook_font_color: formData.hook_font_color,
          hook_position: formData.hook_position,
          hook_font_size: parseInt(formData.hook_font_size) || 26,
          hook_show_bg: formData.hook_show_bg,
        }),
      });

      if (!res.ok) {
        const rawBody = await res.text();
        try {
          const err = JSON.parse(rawBody);
          throw new Error(err.detail || "Preview generation failed");
        } catch {
          throw new Error(rawBody || "Preview generation failed");
        }
      }

      const data = await res.json();
      setPreviewClip(data);
    } catch (err: any) {
      setErrorMsg(err.message || "Preview generation failed");
    } finally {
      setIsGeneratingPreview(false);
    }
  };

  const handleRunAutomation = async (campaignIdToRun?: string) => {
    const targetId = campaignIdToRun || savedCampaignId;
    if (!targetId) return;

    setIsRunningAutomation(true);
    setActiveAutomationId(targetId);
    setAutomationProgress({
      progress: 5,
      stage: "starting",
      details: "Initializing campaign automation pipeline...",
      completed: false,
    });
    setErrorMsg("");

    try {
      const res = await apiFetch(`${apiUrl}/campaigns/${targetId}/run-full-automation`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subtitle_template: formData.subtitle_template,
          font_family: formData.font_family,
          font_size: parseInt(formData.font_size) || 24,
          font_color: formData.font_color,
          highlight_color: formData.highlight_color,
          stroke_color: formData.stroke_color,
          margin_v_ratio: parseFloat(formData.margin_v_ratio) || 0.42,
          hook_font_family: formData.hook_font_family,
          hook_font_color: formData.hook_font_color,
          hook_position: formData.hook_position,
          hook_font_size: parseInt(formData.hook_font_size) || 26,
          hook_show_bg: formData.hook_show_bg,
          clips_per_video: 2,
        }),
      });

      if (!res.ok) {
        const rawBody = await res.text();
        try {
          const err = JSON.parse(rawBody);
          throw new Error(err.detail || "Automation failed");
        } catch {
          throw new Error(rawBody || "Automation failed");
        }
      }
    } catch (err: any) {
      setErrorMsg(err.message || "Automation launch failed");
      setIsRunningAutomation(false);
    }
  };

  const syncAnalytics = async (campaignId: string) => {
    setSyncingId(campaignId);
    try {
      const res = await apiFetch(`${apiUrl}/campaigns/${campaignId}/sync-analytics`, {
        method: "POST",
      });
      if (res.ok) {
        fetchCampaigns();
      }
    } catch (err) {
      console.error("Failed to sync analytics", err);
    } finally {
      setSyncingId(null);
    }
  };

  const formatDuration = (seconds?: number) => {
    if (!seconds) return "";
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
  };

  const totalEarnings = campaigns.reduce((acc, c) => acc + (c.total_estimated_payout || 0), 0);
  const totalViewsAll = campaigns.reduce((acc, c) => acc + (c.total_views || 0), 0);

  const renderWizardStepIndicator = () => (
    <div className="flex items-center gap-2 mb-6">
      {[
        { step: 1, label: "Campaign Details" },
        { step: 2, label: "Video Sources" },
        { step: 3, label: "Preview & Style Editor" },
      ].map((s, i) => (
        <div key={s.step} className="flex items-center gap-2">
          <div
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-bold transition-all ${
              wizardStep === s.step
                ? "bg-purple-600 text-white shadow-lg shadow-purple-500/30"
                : wizardStep > s.step
                ? "bg-emerald-500/20 text-emerald-400 border border-emerald-500/30"
                : "bg-white/5 text-gray-500 border border-white/10"
            }`}
          >
            {wizardStep > s.step ? <CheckCircle2 className="w-3 h-3" /> : <span>{s.step}</span>}
            <span className="hidden sm:inline">{s.label}</span>
          </div>
          {i < 2 && <ChevronRight className="w-4 h-4 text-gray-600" />}
        </div>
      ))}
    </div>
  );

  const renderStep1 = () => (
    <form onSubmit={handleSaveCampaignDetails} className="space-y-4 text-sm">
      <div>
        <label className="block text-xs font-semibold text-gray-300 mb-1 uppercase">Campaign Name *</label>
        <input
          type="text"
          required
          placeholder="e.g., Whop Clipping Campaign"
          value={formData.campaign_name}
          onChange={(e) => setFormData({ ...formData, campaign_name: e.target.value })}
          className="w-full px-4 py-2.5 rounded-xl bg-white/5 border border-white/10 text-white focus:outline-none focus:border-purple-500"
        />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label className="block text-xs font-semibold text-gray-300 mb-1 uppercase">Google Doc Link (Rules)</label>
          <input
            type="url"
            placeholder="https://docs.google.com/document/d/..."
            value={formData.google_doc_url}
            onChange={(e) => setFormData({ ...formData, google_doc_url: e.target.value })}
            className="w-full px-4 py-2.5 rounded-xl bg-white/5 border border-white/10 text-white focus:outline-none focus:border-purple-500"
          />
        </div>
        <div>
          <label className="block text-xs font-semibold text-gray-300 mb-1 uppercase">Whop Rate per 1k Views ($)</label>
          <input
            type="number"
            step="0.10"
            placeholder="3.50"
            value={formData.rate_per_1k_views}
            onChange={(e) => setFormData({ ...formData, rate_per_1k_views: e.target.value })}
            className="w-full px-4 py-2.5 rounded-xl bg-white/5 border border-white/10 text-white focus:outline-none focus:border-purple-500"
          />
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label className="block text-xs font-semibold text-gray-300 mb-1 uppercase">Instagram Username *</label>
          <input
            type="text"
            required
            placeholder="dedicated_whop_handle"
            value={formData.instagram_username}
            onChange={(e) => setFormData({ ...formData, instagram_username: e.target.value })}
            className="w-full px-4 py-2.5 rounded-xl bg-white/5 border border-white/10 text-white focus:outline-none focus:border-purple-500"
          />
          <span className="text-[10px] text-purple-400 mt-1 block">Enter Instagram handle (e.g. sher.clips)</span>
        </div>
        <div>
          <label className="block text-xs font-semibold text-gray-300 mb-1 uppercase">Instagram Password</label>
          <input
            type="password"
            placeholder={editingCampaign ? "Leave blank to keep existing" : "Account password"}
            value={formData.instagram_password}
            onChange={(e) => setFormData({ ...formData, instagram_password: e.target.value })}
            className="w-full px-4 py-2.5 rounded-xl bg-white/5 border border-white/10 text-white focus:outline-none focus:border-purple-500"
          />
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label className="block text-xs font-semibold text-gray-300 mb-1 uppercase">Mandatory Tag Handles</label>
          <input
            type="text"
            placeholder="@client, @brand"
            value={formData.mandatory_tags}
            onChange={(e) => setFormData({ ...formData, mandatory_tags: e.target.value })}
            className="w-full px-4 py-2.5 rounded-xl bg-white/5 border border-white/10 text-white focus:outline-none focus:border-purple-500"
          />
        </div>
        <div>
          <label className="block text-xs font-semibold text-gray-300 mb-1 uppercase">Required Profile Bio Link</label>
          <input
            type="url"
            placeholder="https://whop.com/checkout/..."
            value={formData.required_bio_link}
            onChange={(e) => setFormData({ ...formData, required_bio_link: e.target.value })}
            className="w-full px-4 py-2.5 rounded-xl bg-white/5 border border-white/10 text-white focus:outline-none focus:border-purple-500"
          />
        </div>
      </div>

      <div className="flex justify-end gap-3 pt-4 border-t border-white/10">
        <button
          type="button"
          onClick={() => setShowModal(false)}
          className="px-5 py-2.5 rounded-xl bg-white/5 hover:bg-white/10 text-gray-300 font-semibold"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={submitting}
          className="px-6 py-2.5 rounded-xl bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-500 hover:to-purple-500 text-white font-bold transition-all flex items-center gap-2"
        >
          {submitting ? <RefreshCw className="w-4 h-4 animate-spin" /> : <ChevronRight className="w-4 h-4" />}
          Save & Continue
        </button>
      </div>
    </form>
  );

  const renderStep2 = () => (
    <div className="space-y-5 text-sm">
      <div>
        <label className="block text-xs font-semibold text-gray-300 mb-1 uppercase">
          YouTube / Video Links (One or more, one per line)
        </label>
        <textarea
          rows={3}
          placeholder={`https://youtube.com/watch?v=...\nhttps://youtube.com/watch?v=...`}
          value={formData.drive_url}
          onChange={(e) => setFormData({ ...formData, drive_url: e.target.value })}
          className="w-full px-4 py-2 rounded-xl bg-white/5 border border-white/10 text-white focus:outline-none focus:border-purple-500 text-xs font-mono"
        />
        <span className="text-[10px] text-gray-400 mt-1 block">Paste YouTube URLs. Videos are auto-downloaded via yt-dlp.</span>
      </div>

      <div>
        <label className="block text-xs font-semibold text-gray-300 mb-1 uppercase">Or Upload Local MP4 Videos</label>
        <div className="border-2 border-dashed border-white/15 hover:border-purple-500/50 rounded-xl p-3 text-center bg-white/5 transition-all">
          <input
            type="file"
            multiple
            accept="video/*"
            onChange={async (e) => {
              const files = Array.from(e.target.files || []);
              setSelectedFiles(files);
              if (files.length > 0) {
                await handleAutoUploadFiles(files);
              }
            }}
            className="hidden"
            id="local-video-upload"
          />
          <label htmlFor="local-video-upload" className="cursor-pointer flex flex-col items-center gap-1 text-xs text-gray-400 hover:text-white">
            <span className="font-semibold text-purple-400">Click to upload local .mp4 videos</span>
            {selectedFiles.length > 0 ? (
              <span className="text-emerald-400 font-bold">{selectedFiles.length} file(s) selected</span>
            ) : (
              <span>Select files from your device</span>
            )}
          </label>
        </div>
      </div>

      <button
        onClick={async () => {
          if (savedCampaignId) {
            await apiFetch(`${apiUrl}/campaigns/${savedCampaignId}`, {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ drive_url: formData.drive_url }),
            });
          }
          handleDownloadVideos();
        }}
        disabled={isDownloading}
        className="w-full flex items-center justify-center gap-2 px-5 py-3 rounded-xl bg-gradient-to-r from-blue-600 to-cyan-600 hover:from-blue-500 hover:to-cyan-500 text-white font-bold shadow-lg shadow-blue-500/20 transition-all disabled:opacity-50"
      >
        {isDownloading ? (
          <>
            <RefreshCw className="w-5 h-5 animate-spin" />
            Uploading & Downloading Videos...
          </>
        ) : (
          <>
            <Download className="w-5 h-5" />
            Fetch & Download Videos
          </>
        )}
      </button>

      {downloadedVideos.length > 0 && (
        <div className="space-y-2">
          <div className="text-xs font-bold text-gray-300 uppercase flex justify-between items-center">
            <span>Downloaded Videos ({downloadedVideos.length})</span>
            <span className="text-[10px] text-gray-400 font-normal">Click red trash icon to delete video</span>
          </div>
          {downloadedVideos.map((v, i) => (
            <div key={i} className={`flex items-center gap-3 p-3 rounded-xl border ${v.status === "downloaded" ? "bg-emerald-500/5 border-emerald-500/20" : "bg-red-500/5 border-red-500/20"}`}>
              {v.status === "downloaded" ? (
                <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0" />
              ) : (
                <AlertCircle className="w-5 h-5 text-red-400 shrink-0" />
              )}
              <div className="flex-1 min-w-0">
                <div className="text-white text-xs font-semibold truncate">{v.title || v.url}</div>
                <div className="text-gray-400 text-[10px]">
                  {v.duration ? `${formatDuration(v.duration)}` : ""}
                  {v.error ? ` • Error: ${v.error}` : ""}
                </div>
              </div>
              {v.thumbnail && (
                <img src={v.thumbnail} alt="" className="w-16 h-10 rounded object-cover" />
              )}
              <button
                type="button"
                onClick={() => handleDeleteDownloadedVideo(v.url || v.local_path)}
                className="p-2 rounded-lg bg-red-500/10 hover:bg-red-500/20 text-red-400 transition-all ml-1"
                title="Delete this downloaded video source"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="flex justify-between gap-3 pt-4 border-t border-white/10">
        <button
          type="button"
          onClick={() => setWizardStep(1)}
          className="px-5 py-2.5 rounded-xl bg-white/5 hover:bg-white/10 text-gray-300 font-semibold flex items-center gap-2"
        >
          <ChevronLeft className="w-4 h-4" /> Back
        </button>
        <button
          type="button"
          onClick={async () => {
            if (selectedFiles.length > 0) {
              await handleAutoUploadFiles(selectedFiles);
            }
            if (savedCampaignId && downloadedVideos.length === 0) {
              await fetchDownloadedVideos(savedCampaignId);
            }
            setWizardStep(3);
          }}
          className="px-6 py-2.5 rounded-xl bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-500 hover:to-purple-500 text-white font-bold transition-all flex items-center gap-2"
        >
          <ChevronRight className="w-4 h-4" /> Continue to Preview & Style Editor
        </button>
      </div>
    </div>
  );

  const renderStep3 = () => (
    <div className="space-y-5 text-sm">
      {/* Complete Review Page Editing Section */}
      <div className="p-5 rounded-2xl bg-purple-950/20 border border-purple-500/30 space-y-5">
        <div className="flex items-center justify-between border-b border-purple-500/20 pb-3">
          <div className="flex items-center gap-2 text-xs font-bold text-purple-300 uppercase tracking-wider">
            <Palette className="w-4 h-4 text-purple-400" /> Complete Review Page Style Controls
          </div>
          <span className="text-[10px] bg-purple-500/20 text-purple-300 px-2 py-0.5 rounded-md border border-purple-500/30">
            Preview Mode
          </span>
        </div>

        {/* Template selector */}
        <div>
          <label className="block text-[10px] font-semibold text-gray-400 mb-1.5 uppercase">Subtitle Animation Template</label>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {TEMPLATES.map((t) => (
              <button
                key={t.value}
                type="button"
                onClick={() => setFormData({ ...formData, subtitle_template: t.value })}
                className={`p-2.5 rounded-xl border text-left transition-all ${
                  formData.subtitle_template === t.value
                    ? "bg-purple-600/30 border-purple-500 text-purple-200 shadow-md shadow-purple-500/20"
                    : "bg-white/5 border-white/10 text-gray-400 hover:border-white/20"
                }`}
              >
                <div className="text-xs font-bold">{t.name}</div>
                <div className="text-[10px] text-gray-500 leading-tight">{t.desc}</div>
              </button>
            ))}
          </div>
        </div>

        {/* Font Family & Sizes */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <label className="block text-[10px] font-semibold text-gray-400 mb-1 uppercase">Font Family (16 Fonts)</label>
            <select
              value={formData.font_family}
              onChange={(e) => setFormData({ ...formData, font_family: e.target.value })}
              className="w-full px-3 py-2 rounded-xl bg-slate-900 border border-white/15 text-white text-xs font-semibold"
            >
              {AVAILABLE_FONTS_LIST.map((f) => (
                <option key={f.value} value={f.value}>{f.name}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-[10px] font-semibold text-gray-400 mb-1 uppercase">Subtitle Size ({formData.font_size}px)</label>
            <input
              type="range"
              min="16"
              max="48"
              value={formData.font_size}
              onChange={(e) => setFormData({ ...formData, font_size: e.target.value })}
              className="w-full accent-purple-500"
            />
          </div>

          <div>
            <label className="block text-[10px] font-semibold text-gray-400 mb-1 uppercase">Vertical Position ({(parseFloat(formData.margin_v_ratio) * 100).toFixed(0)}%)</label>
            <input
              type="range"
              min="0.1"
              max="0.9"
              step="0.01"
              value={formData.margin_v_ratio}
              onChange={(e) => setFormData({ ...formData, margin_v_ratio: e.target.value })}
              className="w-full accent-purple-500"
            />
          </div>
        </div>

        {/* Subtitle Colors */}
        <div className="grid grid-cols-3 gap-3">
          <div>
            <label className="block text-[10px] font-semibold text-gray-400 mb-1 uppercase">Font Color</label>
            <div className="flex items-center gap-2">
              <input
                type="color"
                value={formData.font_color}
                onChange={(e) => setFormData({ ...formData, font_color: e.target.value })}
                className="w-8 h-8 rounded-lg border-none cursor-pointer bg-transparent"
              />
              <span className="text-[10px] text-gray-300 font-mono">{formData.font_color}</span>
            </div>
          </div>

          <div>
            <label className="block text-[10px] font-semibold text-gray-400 mb-1 uppercase">Highlight Color</label>
            <div className="flex items-center gap-2">
              <input
                type="color"
                value={formData.highlight_color}
                onChange={(e) => setFormData({ ...formData, highlight_color: e.target.value })}
                className="w-8 h-8 rounded-lg border-none cursor-pointer bg-transparent"
              />
              <span className="text-[10px] text-gray-300 font-mono">{formData.highlight_color}</span>
            </div>
          </div>

          <div>
            <label className="block text-[10px] font-semibold text-gray-400 mb-1 uppercase">Stroke Color</label>
            <div className="flex items-center gap-2">
              <input
                type="color"
                value={formData.stroke_color}
                onChange={(e) => setFormData({ ...formData, stroke_color: e.target.value })}
                className="w-8 h-8 rounded-lg border-none cursor-pointer bg-transparent"
              />
              <span className="text-[10px] text-gray-300 font-mono">{formData.stroke_color}</span>
            </div>
          </div>
        </div>

        {/* On-Screen Hype Text / Hook Title Customization (Review Page Parity) */}
        <div className="p-3.5 rounded-xl bg-white/5 border border-white/10 space-y-3">
          <div className="flex items-center gap-2 text-xs font-bold text-yellow-300 uppercase">
            <Type className="w-3.5 h-3.5" /> On-Screen Hype Hook Title
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-[10px] font-semibold text-gray-400 mb-1 uppercase">Hook Text</label>
              <input
                type="text"
                placeholder="e.g. Viral Moment Highlight"
                value={formData.hook_text}
                onChange={(e) => setFormData({ ...formData, hook_text: e.target.value })}
                className="w-full px-3 py-2 rounded-lg bg-slate-900 border border-white/10 text-white text-xs"
              />
            </div>
            <div>
              <label className="block text-[10px] font-semibold text-gray-400 mb-1 uppercase">Hook Font</label>
              <select
                value={formData.hook_font_family}
                onChange={(e) => setFormData({ ...formData, hook_font_family: e.target.value })}
                className="w-full px-3 py-2 rounded-lg bg-slate-900 border border-white/10 text-white text-xs"
              >
                {AVAILABLE_FONTS_LIST.map((f) => (
                  <option key={f.value} value={f.value}>{f.name}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="block text-[10px] font-semibold text-gray-400 mb-1 uppercase">Hook Position</label>
              <div className="flex rounded-lg bg-slate-900 p-0.5 border border-white/10">
                {["top", "center", "bottom"].map((pos) => (
                  <button
                    key={pos}
                    type="button"
                    onClick={() => setFormData({ ...formData, hook_position: pos })}
                    className={`flex-1 text-[10px] font-bold py-1 rounded capitalize ${
                      formData.hook_position === pos ? "bg-purple-600 text-white" : "text-gray-400"
                    }`}
                  >
                    {pos}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="block text-[10px] font-semibold text-gray-400 mb-1 uppercase">Hook Size ({formData.hook_font_size}px)</label>
              <input
                type="range"
                min="16"
                max="48"
                value={formData.hook_font_size}
                onChange={(e) => setFormData({ ...formData, hook_font_size: e.target.value })}
                className="w-full accent-yellow-500"
              />
            </div>

            <div>
              <label className="block text-[10px] font-semibold text-gray-400 mb-1 uppercase">Hook Background</label>
              <button
                type="button"
                onClick={() => setFormData({ ...formData, hook_show_bg: !formData.hook_show_bg })}
                className={`w-full py-1.5 rounded-lg text-xs font-bold border transition-all ${
                  formData.hook_show_bg
                    ? "bg-yellow-500/20 border-yellow-500/40 text-yellow-300"
                    : "bg-white/5 border-white/10 text-gray-400"
                }`}
              >
                {formData.hook_show_bg ? "Background On" : "No Background"}
              </button>
            </div>
          </div>
        </div>

        {/* Aspect Ratio & Transitions (Review Page Parity) */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-[10px] font-semibold text-gray-400 mb-1 uppercase">Target Video Aspect Ratio</label>
            <div className="flex rounded-xl bg-slate-900 p-1 border border-white/10">
              {["9:16", "1:1", "16:9"].map((ar) => (
                <button
                  key={ar}
                  type="button"
                  onClick={() => setFormData({ ...formData, aspect_ratio: ar })}
                  className={`flex-1 text-xs font-bold py-1.5 rounded-lg ${
                    formData.aspect_ratio === ar ? "bg-gradient-to-r from-blue-600 to-purple-600 text-white" : "text-gray-400"
                  }`}
                >
                  {ar}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-[10px] font-semibold text-gray-400 mb-1 uppercase">Dynamic Video Transitions</label>
            <button
              type="button"
              onClick={() => setFormData({ ...formData, transitions_enabled: !formData.transitions_enabled })}
              className={`w-full py-2.5 rounded-xl text-xs font-bold border transition-all ${
                formData.transitions_enabled
                  ? "bg-emerald-500/20 border-emerald-500/40 text-emerald-300"
                  : "bg-white/5 border-white/10 text-gray-400"
              }`}
            >
              {formData.transitions_enabled ? "Transitions Enabled (Cut Zoom)" : "Transitions Disabled"}
            </button>
          </div>
        </div>
      </div>

      {/* Generate / Re-render Preview Clip Button */}
      <button
        onClick={handleGeneratePreview}
        disabled={isGeneratingPreview}
        className="w-full flex items-center justify-center gap-2 px-5 py-3 rounded-xl bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 text-white font-bold shadow-lg shadow-cyan-500/20 transition-all disabled:opacity-50"
      >
        {isGeneratingPreview ? (
          <>
            <RefreshCw className="w-5 h-5 animate-spin" />
            Analyzing video & generating 1st preview clip...
          </>
        ) : (
          <>
            <Eye className="w-5 h-5" />
            {previewClip ? "Re-render 1st Preview Clip" : "Generate 1st Preview Clip"}
          </>
        )}
      </button>

      {/* Preview clip video player with ASS subtitle overlay */}
      {previewClip && (
        <div className="p-4 rounded-xl bg-slate-800/90 border border-emerald-500/30 space-y-3 shadow-2xl">
          <div className="text-xs font-bold text-emerald-400 uppercase flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4" /> 1st Preview Clip Live Video Player
          </div>
          <div className="relative aspect-[9/16] max-w-[260px] mx-auto rounded-xl overflow-hidden bg-black shadow-2xl border border-white/10">
            <video
              ref={(el) => {
                previewVideoRef.current = el;
                setVideoEl(el);
              }}
              src={`${apiUrl}${previewClip.preview_video_url}`}
              controls
              autoPlay
              muted
              className="w-full h-full object-contain"
            />
            {videoEl && liveAssContent && (
              <AssSubtitleRenderer
                videoElement={videoEl}
                assContent={liveAssContent}
                enabled={true}
              />
            )}
          </div>
          <div className="text-center space-y-1">
            <div className="text-xs text-gray-200 font-semibold">{previewClip.clip_data.text}</div>
            <div className="text-[10px] text-purple-400 font-medium">
              Hook: {formData.hook_text} • {previewClip.clip_data.duration.toFixed(1)}s
            </div>
          </div>
        </div>
      )}

      {/* Real-time Automation Progress Bar */}
      {automationProgress && (
        <div className="p-5 rounded-2xl bg-slate-900 border border-purple-500/40 space-y-3 shadow-2xl">
          <div className="flex justify-between items-center text-xs font-bold">
            <span className="text-purple-300 uppercase flex items-center gap-1.5">
              <RefreshCw className={`w-4 h-4 ${automationProgress.completed ? "" : "animate-spin text-purple-400"}`} />
              Automation Stage: {automationProgress.stage.toUpperCase()}
            </span>
            <span className="text-emerald-400 font-mono text-base">{automationProgress.progress}%</span>
          </div>

          <div className="w-full h-3.5 bg-white/10 rounded-full overflow-hidden p-0.5">
            <div
              className="h-full bg-gradient-to-r from-blue-500 via-purple-500 to-emerald-400 rounded-full transition-all duration-500 shadow-lg shadow-purple-500/50"
              style={{ width: `${automationProgress.progress}%` }}
            />
          </div>

          <p className="text-xs text-gray-300 font-medium">{automationProgress.details}</p>

          {automationProgress.completed && (
            <div className="p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 text-xs font-bold flex items-center gap-2">
              <CheckCircle2 className="w-5 h-5 shrink-0" /> All clips edited with exact style template & published to Instagram!
            </div>
          )}
        </div>
      )}

      <div className="flex justify-between gap-3 pt-4 border-t border-white/10">
        <button
          type="button"
          onClick={() => setWizardStep(2)}
          className="px-5 py-2.5 rounded-xl bg-white/5 hover:bg-white/10 text-gray-300 font-semibold flex items-center gap-2"
        >
          <ChevronLeft className="w-4 h-4" /> Back
        </button>
        <button
          onClick={() => handleRunAutomation()}
          disabled={isRunningAutomation && !automationProgress?.completed}
          className="px-6 py-3 rounded-xl bg-gradient-to-r from-emerald-600 to-purple-600 hover:from-emerald-500 hover:to-purple-500 text-white font-bold transition-all flex items-center gap-2 shadow-lg shadow-emerald-500/20 disabled:opacity-50"
        >
          {isRunningAutomation && !automationProgress?.completed ? (
            <>
              <RefreshCw className="w-5 h-5 animate-spin" />
              Running Automation ({automationProgress?.progress || 5}%)...
            </>
          ) : (
            <>
              <Zap className="w-5 h-5" />
              Approve Style & Edit All Clips via AI
            </>
          )}
        </button>
      </div>
    </div>
  );

  return (
    <div className="p-6 md:p-10 max-w-7xl mx-auto space-y-8 text-white">
      {/* Header Banner */}
      <div className="relative overflow-hidden rounded-2xl bg-gradient-to-r from-purple-900/60 via-blue-900/40 to-slate-900 p-8 border border-white/10 shadow-2xl">
        <div className="relative z-10 flex flex-col md:flex-row justify-between items-start md:items-center gap-6">
          <div>
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-emerald-500/20 text-emerald-400 text-xs font-semibold uppercase tracking-wider mb-3 border border-emerald-500/30">
              <Sparkles className="w-3.5 h-3.5" /> Whop Pay-Per-View Automation
            </div>
            <h1 className="text-3xl font-extrabold tracking-tight">Whop Clipping Campaigns</h1>
            <p className="text-gray-400 text-sm mt-1 max-w-xl">
              Preview 1st clip → customize subtitle layout & styles → AI batch edits all clips following your rules → publish to Instagram.
            </p>
          </div>
          <button
            onClick={openCreateModal}
            className="flex items-center gap-2 px-5 py-3 rounded-xl bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-500 hover:to-purple-500 text-white font-bold shadow-lg shadow-purple-500/25 transition-all transform hover:-translate-y-0.5"
          >
            <Plus className="w-5 h-5" /> New Whop Campaign
          </button>
        </div>

        {/* Global Analytics Overview */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-8 pt-6 border-t border-white/10">
          <div className="bg-white/5 rounded-xl p-4 border border-white/5">
            <span className="text-xs text-gray-400 uppercase tracking-wider">Total Estimated Earnings</span>
            <div className="text-2xl font-black text-emerald-400 mt-1 flex items-center gap-1">
              <DollarSign className="w-6 h-6 text-emerald-400" />
              {totalEarnings.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </div>
          </div>

          <div className="bg-white/5 rounded-xl p-4 border border-white/5">
            <span className="text-xs text-gray-400 uppercase tracking-wider">Total Campaign Views</span>
            <div className="text-2xl font-black text-blue-400 mt-1">
              {totalViewsAll.toLocaleString()}
            </div>
          </div>

          <div className="bg-white/5 rounded-xl p-4 border border-white/5">
            <span className="text-xs text-gray-400 uppercase tracking-wider">Active Campaigns</span>
            <div className="text-2xl font-black text-purple-400 mt-1">
              {campaigns.length}
            </div>
          </div>
        </div>
      </div>

      {/* Global Progress Bar (if automation active) */}
      {activeAutomationId && automationProgress && (
        <div className="p-5 rounded-2xl bg-slate-900 border border-purple-500/40 shadow-2xl space-y-3">
          <div className="flex justify-between items-center text-sm font-bold">
            <span className="text-purple-300 uppercase flex items-center gap-2">
              <Zap className="w-4 h-4 text-yellow-400" />
              Automation Running: {automationProgress.stage.toUpperCase()}
            </span>
            <span className="text-emerald-400 font-mono text-base">{automationProgress.progress}%</span>
          </div>

          <div className="w-full h-3.5 bg-white/10 rounded-full overflow-hidden p-0.5">
            <div
              className="h-full bg-gradient-to-r from-blue-500 via-purple-500 to-emerald-400 rounded-full transition-all duration-500 shadow-lg shadow-purple-500/50"
              style={{ width: `${automationProgress.progress}%` }}
            />
          </div>

          <div className="flex justify-between text-xs text-gray-300">
            <span>{automationProgress.details}</span>
            {automationProgress.completed && (
              <span className="text-emerald-400 font-bold flex items-center gap-1">
                <CheckCircle2 className="w-4 h-4" /> Finished
              </span>
            )}
          </div>
        </div>
      )}

      {/* Campaign Cards List */}
      {loading ? (
        <div className="flex justify-center items-center py-20 text-gray-400">
          <RefreshCw className="w-8 h-8 animate-spin text-purple-500" />
        </div>
      ) : campaigns.length === 0 ? (
        <div className="text-center py-16 px-4 bg-slate-900/50 rounded-2xl border border-white/5 space-y-4">
          <DollarSign className="w-12 h-12 text-gray-600 mx-auto" />
          <h3 className="text-xl font-bold text-gray-300">No Whop Campaigns Found</h3>
          <p className="text-gray-400 text-sm max-w-md mx-auto">
            Paste a YouTube link or upload an MP4 video to launch your first automated clipping campaign.
          </p>
          <button
            onClick={openCreateModal}
            className="px-6 py-2.5 rounded-xl bg-purple-600 hover:bg-purple-500 text-white font-semibold transition-all"
          >
            Create Your First Campaign
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {campaigns.map((c) => (
            <div
              key={c.id}
              className="bg-slate-900/80 rounded-2xl p-6 border border-white/10 hover:border-purple-500/40 transition-all flex flex-col justify-between space-y-5 shadow-xl relative"
            >
              <div>
                <div className="flex justify-between items-start gap-4">
                  <div>
                    <h3 className="text-xl font-bold text-white">{c.campaign_name}</h3>
                    {c.instagram_username && (
                      <div className="flex items-center gap-1.5 text-xs text-purple-400 font-medium mt-1">
                        <Instagram className="w-4 h-4 text-pink-400" />
                        @{c.instagram_username}
                      </div>
                    )}
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => openEditModal(c)}
                      className="p-1.5 rounded-lg bg-white/5 hover:bg-white/15 text-gray-300 transition-all"
                      title="Edit Campaign Settings"
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => handleDeleteCampaign(c.id, c.campaign_name)}
                      disabled={deletingId === c.id}
                      className="p-1.5 rounded-lg bg-red-500/10 hover:bg-red-500/20 text-red-400 transition-all"
                      title="Delete Campaign"
                    >
                      {deletingId === c.id ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                    </button>
                    <span className="px-3 py-1 rounded-full bg-emerald-500/10 text-emerald-400 text-xs font-bold border border-emerald-500/20">
                      ${c.rate_per_1k_views}/1k views
                    </span>
                  </div>
                </div>

                <div className="mt-4 space-y-2 text-xs text-gray-400">
                  {c.google_doc_url && (
                    <div className="flex items-center gap-2 truncate">
                      <FileText className="w-4 h-4 text-blue-400 shrink-0" />
                      <span className="truncate">{c.google_doc_url}</span>
                    </div>
                  )}
                  {c.drive_url && (
                    <div className="flex items-center gap-2 truncate">
                      <Video className="w-4 h-4 text-purple-400 shrink-0" />
                      <span className="truncate">
                        {c.drive_url.trim().split(/\s+/).length > 1
                          ? `${c.drive_url.trim().split(/\s+/).length} Video Sources Connected`
                          : c.drive_url}
                      </span>
                    </div>
                  )}
                  {c.mandatory_tags && (
                    <div className="text-gray-300 font-medium pt-1">
                      <span className="text-gray-500">Tags: </span> {c.mandatory_tags}
                    </div>
                  )}
                  {c.subtitle_template && (
                    <div className="text-gray-300 font-medium">
                      <span className="text-gray-500">Style: </span> {c.subtitle_template} • {c.font_family}
                    </div>
                  )}
                </div>
              </div>

              <div className="pt-4 border-t border-white/10 flex items-center justify-between">
                <div>
                  <span className="text-xs text-gray-500 uppercase tracking-wider block">Estimated Payout</span>
                  <span className="text-xl font-extrabold text-emerald-400">
                    ${c.total_estimated_payout.toFixed(2)}
                  </span>
                  <span className="text-xs text-gray-400 ml-2">({c.total_views.toLocaleString()} views)</span>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    onClick={() => handleRunAutomation(c.id)}
                    disabled={activeAutomationId === c.id && !automationProgress?.completed}
                    className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-purple-600/30 hover:bg-purple-600/50 text-purple-200 text-xs font-bold border border-purple-500/30 transition-all disabled:opacity-50"
                  >
                    {activeAutomationId === c.id && !automationProgress?.completed ? (
                      <RefreshCw className="w-3.5 h-3.5 animate-spin text-purple-400" />
                    ) : (
                      <Play className="w-3.5 h-3.5 text-purple-400 fill-purple-400" />
                    )}
                    <span>Run Automation</span>
                  </button>

                  <button
                    onClick={() => syncAnalytics(c.id)}
                    disabled={syncingId === c.id}
                    className="p-2.5 rounded-xl bg-white/5 hover:bg-white/10 text-gray-300 transition-all"
                    title="Sync Instagram Views"
                  >
                    <RefreshCw className={`w-4 h-4 ${syncingId === c.id ? "animate-spin text-purple-400" : ""}`} />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Wizard Modal */}
      {showModal && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 overflow-y-auto">
          <div className="bg-slate-900 rounded-2xl max-w-2xl w-full max-h-[90vh] overflow-y-auto p-6 border border-white/10 shadow-2xl space-y-4">
            <div className="flex justify-between items-center border-b border-white/10 pb-4">
              <h2 className="text-xl font-bold text-white flex items-center gap-2">
                <Sparkles className="w-5 h-5 text-purple-400" />
                {editingCampaign ? "Edit Campaign" : "New Whop Campaign"}
              </h2>
              <button
                onClick={() => setShowModal(false)}
                className="text-gray-400 hover:text-white text-lg font-bold"
              >
                ✕
              </button>
            </div>

            {renderWizardStepIndicator()}

            {errorMsg && (
              <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-sm flex items-center gap-2">
                <AlertCircle className="w-4 h-4 shrink-0" /> {errorMsg}
              </div>
            )}

            {wizardStep === 1 && renderStep1()}
            {wizardStep === 2 && renderStep2()}
            {wizardStep === 3 && renderStep3()}
          </div>
        </div>
      )}
    </div>
  );
}
