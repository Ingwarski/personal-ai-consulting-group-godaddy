import { extractPdfForConsultation, type MatrixConsultationMediaStore } from "./matrix-consultation-media.ts";
import type { ConsultationDocument, ConsultationMediaInput, ConsultationMediaPort } from "./matrix-consultation-service.ts";

/** No binary, metadata-only surrogate or unconfirmed attachment is turned
 * into a prompt. PDFs supply their bounded text layer; images remain native
 * image input. Buffers have an explicit short-lived owner. */
export function createConsultationMediaAdapter(store: MatrixConsultationMediaStore): ConsultationMediaPort {
  return {
    async prepare(documents: readonly ConsultationDocument[], signal?: AbortSignal): Promise<ConsultationMediaInput | undefined> {
      if (documents.some(d => d.confirmed !== true) || signal?.aborted) return undefined;
      const releases: (() => void)[] = [];
      const images: { mime: "image/png" | "image/jpeg"; bytes: Uint8Array }[] = [];
      const texts: string[] = [];
      let transferred = false;
      try {
        for (const document of documents) {
          if (signal?.aborted) return undefined;
          const loaded = await store.load(document.eventHash, document.manifest);
          if (!loaded.ok) return undefined;
          releases.push(loaded.release);
          if (signal?.aborted) return undefined;
          for (const object of loaded.objects) {
            if (object.declaredMime === "application/pdf") {
              const extracted = await extractPdfForConsultation(object.bytes, signal === undefined ? {} : { signal });
              if (!extracted.ok) { await store.erase(document.eventHash, "rejected"); return undefined; }
              texts.push("Текстовий шар PDF; графічні елементи не аналізувалися:\n" + extracted.text);
            } else images.push({ mime: object.declaredMime, bytes: object.bytes });
          }
        }
        if (signal?.aborted) return undefined;
        transferred = true;
        return { images, text: texts.join("\n\n"), release: () => releases.forEach(release => release()) };
      } finally {
        if (!transferred) releases.forEach(release => release());
      }
    },
    erase: hash => store.erase(hash, "processed"),
    purgeExpired: () => store.purgeExpired()
  };
}
