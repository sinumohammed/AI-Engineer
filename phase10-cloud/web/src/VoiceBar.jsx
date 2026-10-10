import { useEffect } from "react";
import { Button, Spin, Tooltip, Typography } from "antd";
import { AudioOutlined, CheckOutlined, CloseOutlined } from "@ant-design/icons";

const { Text } = Typography;
const clock = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

// The mic button inside the input box.
export function MicButton({ onClick, disabled }) {
  return (
    <Tooltip title="Speak instead of typing">
      <Button type="text" shape="circle" icon={<AudioOutlined />} onClick={onClick} disabled={disabled} aria-label="Speak your question" className="mic" />
    </Tooltip>
  );
}

// Shown in place of the input box while recording and transcribing:
// cancel - live level bars and timer - done. Esc cancels, Enter finishes.
export default function VoiceBar({ voice }) {
  const recording = voice.status === "recording";

  useEffect(() => {
    if (!recording) return;
    const onKey = (e) => {
      if (e.key === "Escape") voice.cancel();
      if (e.key === "Enter") {
        e.preventDefault();
        voice.stop();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [recording, voice]);

  return (
    <div className="voicebar" role="status" aria-live="polite">
      <Tooltip title="Cancel (Esc)">
        <Button shape="circle" icon={<CloseOutlined />} onClick={voice.cancel} disabled={!recording} aria-label="Cancel recording" />
      </Tooltip>
      <div className="voice-middle">
        {recording ? (
          <>
            <span className="rec-dot" aria-hidden />
            <Text className="voice-time">{clock(voice.seconds)}</Text>
            <div className="voice-wave" aria-label="Listening">
              {voice.levels.map((l, i) => (
                <span key={i} style={{ height: `${Math.max(10, l * 100)}%` }} />
              ))}
            </div>
            {voice.seconds >= voice.maxSeconds - 15 && (
              <Text type="warning" className="small">stops at {clock(voice.maxSeconds)}</Text>
            )}
          </>
        ) : (
          <>
            <Spin size="small" />
            <Text type="secondary">Turning your voice into text…</Text>
          </>
        )}
      </div>
      <Tooltip title="Done (Enter)">
        <Button type="primary" shape="circle" icon={<CheckOutlined />} onClick={voice.stop} loading={!recording} aria-label="Finish recording" />
      </Tooltip>
    </div>
  );
}
