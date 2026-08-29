'use client';

/**
 * Real document upload (live extraction mode): drag-drop or picker for
 * W-2 / 1099 / K-1 images and PDFs. MULTI-FILE — pick or drop a whole stack.
 *
 * Posts to the /api/upload Route Handler rather than invoking a Server
 * Action: Server Actions cap the request body at 1 MB, so a real scan is
 * rejected before any of our code runs and the browser shows nothing but
 * "Failed to fetch". The route has no such cap and returns a readable error.
 *
 * Files go ONE PER REQUEST, sequentially: it keeps each request small, gives
 * real progress ("Reading 3 of 7"), and makes a failure cost one file rather
 * than the batch. The file never touches client-side JS beyond the POST —
 * no API key and no extraction logic exists in the browser.
 */
import { useRouter } from 'next/navigation';
import { useRef, useState, type DragEvent } from 'react';

const ACCEPT = 'image/png,image/jpeg,image/webp,image/gif,application/pdf';

export function UploadDropzone() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number; current: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function uploadAll(files: FileList | File[]): Promise<void> {
    const list = Array.from(files);
    if (list.length === 0) return;
    setError(null);
    try {
      for (const [i, file] of list.entries()) {
        setProgress({ done: i, total: list.length, current: file.name });
        const body = new FormData();
        body.append('file', file);
        const res = await fetch('/api/upload', { method: 'POST', body });
        if (!res.ok) {
          const detail = await res
            .json()
            .then((j: { message?: string }) => j.message)
            .catch(() => null);
          throw new Error(
            `"${file.name}" (${(file.size / 1024 / 1024).toFixed(1)} MB): ${detail ?? `upload failed with status ${res.status}`}`,
          );
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setProgress(null);
      formRef.current?.reset();
      router.refresh();
    }
  }

  function onDrop(e: DragEvent<HTMLDivElement>): void {
    e.preventDefault();
    setDragOver(false);
    if (progress || e.dataTransfer.files.length === 0) return;
    void uploadAll(e.dataTransfer.files);
  }

  return (
    <form ref={formRef} onSubmit={(e) => e.preventDefault()}>
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        className={`rounded border-2 border-dashed p-6 text-center text-sm ${
          dragOver ? 'border-slate-700 bg-slate-50' : 'border-slate-300'
        }`}
        data-testid="upload-dropzone"
      >
        {progress ? (
          <div data-testid="upload-busy">
            <p className="font-semibold">
              {progress.total > 1
                ? `Reading document ${progress.done + 1} of ${progress.total}: ${progress.current}`
                : `Reading ${progress.current}…`}
            </p>
            <p className="mt-1 text-xs text-slate-500">
              Scanning for SSNs on this machine, then reading the values. Simple forms take seconds; a
              multi-page encrypted brokerage statement can take a minute or two. Keep this tab open.
            </p>
            <div className="mx-auto mt-2 h-1.5 w-64 overflow-hidden rounded bg-slate-200">
              <div
                className="h-full bg-slate-900 transition-all"
                style={{ width: `${Math.round((progress.done / progress.total) * 100)}%` }}
              />
            </div>
          </div>
        ) : (
          <>
            <p className="font-semibold">Drag your W-2s, 1099s, K-1s, or brokerage statements here (images or PDFs)</p>
            <p className="mt-1 text-xs text-slate-500">you can drop or pick several at once — or</p>
            <label className="mt-2 inline-block cursor-pointer rounded bg-slate-900 px-3 py-1.5 text-white">
              Choose files
              <input
                ref={inputRef}
                type="file"
                name="file"
                accept={ACCEPT}
                multiple
                className="hidden"
                data-testid="upload-file-input"
                onChange={(e) => void uploadAll(e.target.files ?? [])}
              />
            </label>
            {error ? (
              <p
                className="mx-auto mt-2 max-w-md rounded border border-red-300 bg-red-50 p-2 text-xs text-red-800"
                data-testid="upload-error"
              >
                {error}
              </p>
            ) : null}
            <p className="mt-2 text-[11px] text-slate-400">
              PNG · JPEG · WebP · GIF · PDF, up to 15 MB each. Hold Ctrl (or Shift) in the file picker to select a
              whole stack. Scrubbed of SSNs on this machine before storage, readable only through your workspace; every extracted value needs
              your confirmation before it counts.
            </p>
          </>
        )}
      </div>
    </form>
  );
}
