import { useRef } from "react";
import { Button, Spin, Tag, Tooltip, Typography } from "antd";
import { FileImageOutlined, FilePdfOutlined, PaperClipOutlined } from "@ant-design/icons";

const { Text } = Typography;

// Phase 10, attachments step 1: a PDF or a photo, read into text by the
// server (api/attachments.js) and kept with the chat.
export const MAX_UPLOAD = 4 * 1024 * 1024; // the API's limit (Vercel allows 4.5 MB)
const MAX_SIDE = 2000; // px - plenty to read a receipt or a page

// Phone photos are often 3-8 MB: shrink to at most 2000 px as a JPEG
// (usually 200-600 KB). If the browser cannot decode the format (HEIC in
// Chrome), the original is sent when it fits.
export async function prepareFile(file) {
  if (!file.type.startsWith("image/")) return file;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && file.size < 1.5 * 1024 * 1024 && file.type !== "image/heic") return file;
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((ok) => canvas.toBlob(ok, "image/jpeg", 0.85));
    return new File([blob], file.name.replace(/\.\w+$/, "") + ".jpg", { type: "image/jpeg" });
  } catch {
    return file;
  }
}

export function AttachButton({ onPick, disabled }) {
  const input = useRef(null);
  return (
    <>
      <Tooltip title="Attach a PDF or a photo">
        <Button
          type="text"
          shape="circle"
          icon={<PaperClipOutlined />}
          onClick={() => input.current?.click()}
          disabled={disabled}
          aria-label="Attach a PDF or a photo"
          className="mic"
        />
      </Tooltip>
      <input
        ref={input}
        type="file"
        accept="application/pdf,image/*"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = ""; // picking the same file again still fires
          if (file) onPick(file);
        }}
      />
    </>
  );
}

// Above the message box: the attached file, or "Reading..." while uploading.
export function AttachmentChip({ attachment, reading, onRemove }) {
  if (reading) {
    return (
      <div className="attach-chip">
        <Spin size="small" />
        <Text type="secondary" className="small">Reading {reading}…</Text>
      </div>
    );
  }
  if (!attachment) return null;
  const icon = attachment.kind === "image" ? <FileImageOutlined /> : <FilePdfOutlined />;
  const detail = attachment.kind === "image" ? "photo" : `${attachment.pages} page${attachment.pages === 1 ? "" : "s"}`;
  return (
    <div className="attach-chip">
      <Tooltip title="Questions in this chat can use this file. It was sent to the AI service to be read - don't attach anything private.">
        <Tag icon={icon} closable onClose={onRemove} color="processing" variant="filled" className="attach-tag">
          <span className="attach-name">{attachment.name}</span> · {detail}
        </Tag>
      </Tooltip>
      {attachment.truncated && (
        <Text type="warning" className="small">only the first {attachment.pagesRead} pages were read</Text>
      )}
    </div>
  );
}

// On a sent message: which file it was asked with.
export function FileTag({ name }) {
  if (!name) return null;
  return (
    <span className="file-tag">
      <PaperClipOutlined /> {name}
    </span>
  );
}
