"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AppLayout } from "@/components/layout/AppLayout";
import { ProcessingView } from "@/components/clip/ProcessingView";
import { useUploadContext } from "@/contexts/upload-context";
import { useJwt } from "@/contexts/jwt-context";
import { CheckCircle2, Film, Loader2, PlayCircle, AlertCircle, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";

interface BatchItem {
  file: File;
  progress: number;
  status: "uploading" | "creating" | "completed" | "failed";
  error?: string;
  taskId?: string;
}

export default function UploadingPage() {
  const router = useRouter();
  const { pendingUpload, setPendingUpload } = useUploadContext();
  const { apiFetch, jwt } = useJwt();
  const apiUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

  const [batchItems, setBatchItems] = useState<BatchItem[]>([]);
  const [overallPhase, setOverallPhase] = useState<"uploading" | "completed" | "failed">("uploading");
  const hasStarted = useRef(false);

  useEffect(() => {
    if (hasStarted.current) return;
    if (!pendingUpload) {
      router.replace("/analysis");
      return;
    }
    if (!jwt) return;

    hasStarted.current = true;

    const filesToUpload: File[] = pendingUpload.files && pendingUpload.files.length > 0
      ? pendingUpload.files
      : pendingUpload.file
        ? [pendingUpload.file]
        : [];

    if (filesToUpload.length === 0) {
      router.replace("/analysis");
      return;
    }

    const initialItems: BatchItem[] = filesToUpload.map((f) => ({
      file: f,
      progress: 0,
      status: "uploading",
    }));

    setBatchItems(initialItems);

    const uploadSingleFile = async (itemIndex: number, file: File): Promise<string> => {
      return new Promise<string>((resolve, reject) => {
        const formData = new FormData();
        formData.append("video", file);

        let targetUploadUrl = "/api/backend/upload";
        if (typeof window !== "undefined") {
          const hostname = window.location.hostname || "localhost";
          targetUploadUrl = `${window.location.protocol}//${hostname}:8000/upload`;
        }

        const xhr = new XMLHttpRequest();
        xhr.upload.addEventListener("progress", (e) => {
          if (e.lengthComputable) {
            const pct = Math.round((e.loaded / e.total) * 100);
            setBatchItems((prev) =>
              prev.map((it, idx) => (idx === itemIndex ? { ...it, progress: pct } : it))
            );
          }
        });

        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            try {
              const res = JSON.parse(xhr.responseText);
              if (res.video_path) {
                resolve(res.video_path);
              } else {
                reject(new Error("Response missing video_path"));
              }
            } catch {
              reject(new Error("Invalid server JSON response"));
            }
          } else {
            reject(new Error(`Upload failed (${xhr.status})`));
          }
        };
        xhr.onerror = () => reject(new Error("Network upload error"));
        xhr.open("POST", targetUploadUrl);
        xhr.send(formData);
      });
    };

    const runBatch = async () => {
      const { config } = pendingUpload;

      // Execute simultaneous uploads & task creation for all files
      const tasks = filesToUpload.map(async (file, idx) => {
        try {
          const videoPath = await uploadSingleFile(idx, file);

          setBatchItems((prev) =>
            prev.map((it, i) => (i === idx ? { ...it, status: "creating", progress: 100 } : it))
          );

          const requestBody: Record<string, unknown> = {
            source: { url: videoPath },
            caption_options: {
              pycaps_template: "word-focus",
              transitions_enabled: false,
              transcript_review_enabled: true,
            },
            transcription_options: { provider: "local" },
            ai_options: {
              provider: "google",
              clips_count: config.clipsCount,
              prompt_id: config.promptId || undefined,
            },
          };

          if (config.srtContent) {
            (requestBody.transcription_options as Record<string, unknown>).srt_content = config.srtContent;
          }

          const response = await apiFetch(`${apiUrl}/tasks/`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(requestBody),
          });

          if (!response.ok) {
            const errData = await response.json();
            throw new Error(errData.detail || "Failed to create task");
          }

          const data = await response.json();
          setBatchItems((prev) =>
            prev.map((it, i) =>
              i === idx ? { ...it, status: "completed", taskId: data.task_id } : it
            )
          );
          return data.task_id;
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : "Upload failed";
          setBatchItems((prev) =>
            prev.map((it, i) => (i === idx ? { ...it, status: "failed", error: errMsg } : it))
          );
          return null;
        }
      });

      const results = await Promise.all(tasks);
      const successfulTasks = results.filter(Boolean);

      if (successfulTasks.length === 1 && filesToUpload.length === 1) {
        // Single file upload -> seamlessly transition to processing view
        router.replace(`/processing/${successfulTasks[0]}`);
        setPendingUpload(null);
      } else {
        setOverallPhase("completed");
      }
    };

    runBatch();
  }, [pendingUpload, jwt, apiUrl, router, setPendingUpload, apiFetch]);

  // Single file fallback processing view
  if (batchItems.length === 1 && batchItems[0].status !== "completed" && batchItems[0].status !== "failed") {
    const item = batchItems[0];
    const taskStatus = {
      task_id: "",
      status: "processing" as const,
      progress: item.status === "creating" ? 100 : item.progress,
      current_step: "upload",
      message: item.status === "creating" ? "Creating video task & extracting AI clips..." : "Simultaneously uploading media...",
      source_title: item.file.name,
    };
    return (
      <AppLayout>
        <ProcessingView taskStatus={taskStatus} />
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div className="max-w-4xl mx-auto py-10 px-4 space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-white flex items-center gap-3">
              <Film className="w-7 h-7 text-primary" />
              Simultaneous Multi-Video Clipping
            </h1>
            <p className="text-sm text-gray-400 mt-1">
              Processing {batchItems.length} videos simultaneously. Clips are automatically created in parallel.
            </p>
          </div>
          <Button
            onClick={() => router.push("/dashboard")}
            variant="outline"
            className="border-border text-white hover:bg-muted"
          >
            View Dashboard
          </Button>
        </div>

        {/* Simultaneous Batch List */}
        <div className="space-y-4">
          {batchItems.map((item, idx) => (
            <div
              key={idx}
              className={`glass rounded-2xl p-5 border transition-all ${
                item.status === "completed"
                  ? "border-green-500/40 bg-green-500/5"
                  : item.status === "failed"
                    ? "border-red-500/40 bg-red-500/5"
                    : "border-primary/40 bg-primary/5 glow-purple"
              }`}
            >
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-10 h-10 rounded-xl bg-slate-900 flex items-center justify-center font-bold text-primary shrink-0 border border-primary/30">
                    {idx + 1}
                  </div>
                  <div className="min-w-0">
                    <h3 className="text-sm font-bold text-white truncate max-w-xs md:max-w-md">
                      {item.file.name}
                    </h3>
                    <p className="text-xs text-gray-400 font-mono">
                      {(item.file.size / (1024 * 1024)).toFixed(1)} MB
                    </p>
                  </div>
                </div>

                {/* Status Badge & Actions */}
                <div className="flex items-center gap-3 shrink-0">
                  {item.status === "uploading" && (
                    <span className="flex items-center gap-2 text-xs font-semibold text-primary bg-primary/20 px-3 py-1.5 rounded-full">
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Uploading ({item.progress}%)
                    </span>
                  )}
                  {item.status === "creating" && (
                    <span className="flex items-center gap-2 text-xs font-semibold text-yellow-400 bg-yellow-400/20 px-3 py-1.5 rounded-full">
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Creating Clips...
                    </span>
                  )}
                  {item.status === "completed" && (
                    <div className="flex items-center gap-2">
                      <span className="flex items-center gap-1.5 text-xs font-semibold text-green-400 bg-green-400/20 px-3 py-1.5 rounded-full">
                        <CheckCircle2 className="w-4 h-4" />
                        Ready
                      </span>
                      {item.taskId && (
                        <Button
                          onClick={() => router.push(`/review/${item.taskId}`)}
                          size="sm"
                          className="bg-primary hover:bg-primary/80 text-white font-bold text-xs glow-purple flex items-center gap-1.5"
                        >
                          Review & Edit Clips
                          <ArrowRight className="w-3.5 h-3.5" />
                        </Button>
                      )}
                    </div>
                  )}
                  {item.status === "failed" && (
                    <span className="flex items-center gap-1.5 text-xs font-semibold text-red-400 bg-red-400/20 px-3 py-1.5 rounded-full">
                      <AlertCircle className="w-4 h-4" />
                      {item.error || "Failed"}
                    </span>
                  )}
                </div>
              </div>

              {/* Progress bar */}
              {item.status === "uploading" && (
                <div className="mt-4">
                  <div className="h-2 bg-slate-900 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-gradient-purple transition-all duration-300"
                      style={{ width: `${item.progress}%` }}
                    />
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </AppLayout>
  );
}
