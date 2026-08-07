import { type NextRequest } from "next/server";

export const dynamic = "force-dynamic";

/**
 * Upload proxy for video files.
 *
 * Next.js rewrites buffer large request bodies and cause ECONNRESET errors
 * for big file uploads. This route streams the multipart form data directly
 * to the backend without buffering.
 */
export async function POST(request: NextRequest) {
  const backendUrl = process.env.BACKEND_INTERNAL_URL || "http://backend:8000";

  try {
    const formData = await request.formData();
    const backendResponse = await fetch(`${backendUrl}/upload`, {
      method: "POST",
      body: formData,
    });

    const data = await backendResponse.json();
    return Response.json(data, { status: backendResponse.status });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Upload failed";
    return Response.json({ detail: message }, { status: 500 });
  }
}
