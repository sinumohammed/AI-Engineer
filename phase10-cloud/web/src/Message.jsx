import { Alert, App as AntApp, Avatar, Button, Tag, Tooltip, Typography, theme } from "antd";
import { Bubble } from "@ant-design/x";
import XMarkdown from "@ant-design/x-markdown";
import {
  CheckCircleFilled,
  CopyOutlined,
  FileSearchOutlined,
  LoadingOutlined,
  MinusCircleOutlined,
  WarningFilled,
} from "@ant-design/icons";
import { AGENT_LABELS } from "./Sidebar.jsx";
import { shortTime, fullTime } from "./time.js";
import { FileTag } from "./Attachment.jsx";

const { Text, Paragraph } = Typography;

// What the document search led to (Phase 9): "used" - the answer comes from
// the handbook; "not relevant" - it searched, but the answer comes from the
// model's own knowledge; "code not found" - the asked-for code is in no
// document (5.6).
const OUTCOMES = {
  used: { color: "success", text: "found in the handbook" },
  "not relevant": { color: "default", text: "nothing relevant in the handbook" },
  "code not found": { color: "warning", text: "that code is in no document" },
};

function ProcessChips({ m }) {
  const tools = m.tools ?? [];
  const agents = m.agents ?? [];
  if (!tools.length && !agents.length) return null;
  return (
    <div className="process">
      {tools.map((t, i) => {
        const o = OUTCOMES[t.outcome];
        return (
          <Tag
            key={`t${i}`}
            variant="filled"
            color={t.status === "calling" ? "processing" : o?.color ?? "success"}
            icon={t.status === "calling" ? <LoadingOutlined /> : <FileSearchOutlined />}
          >
            {t.status === "calling" ? "Searching the handbook…" : o ? `Searched: ${o.text}` : "Searched the handbook"}
          </Tag>
        );
      })}
      {/* Phase 8c: the supervisor's hand-off - one tag per specialist (hover
          or long-press for the task it was given). */}
      {agents.length > 0 && <Text type="secondary" className="small">{m.route?.manual ? "Picked:" : "Routed to:"}</Text>}
      {agents.map((a) => (
        <Tooltip key={`a${a.index}`} title={a.question}>
          <Tag
            variant="filled"
            color={a.status === "running" ? "processing" : "purple"}
            icon={a.status === "running" ? <LoadingOutlined /> : <CheckCircleFilled />}
          >
            {AGENT_LABELS[a.agent] ?? a.agent}
            {a.latencyMs != null && ` · ${(a.latencyMs / 1000).toFixed(1)}s`}
          </Tag>
        </Tooltip>
      ))}
      {m.route?.reason && (
        <Paragraph type="secondary" className="route-reason" ellipsis={{ rows: 1, expandable: true, symbol: "why?" }}>
          {m.route.reason}
        </Paragraph>
      )}
    </div>
  );
}

function Sources({ sources }) {
  if (!sources?.length) return null;
  return (
    <div className="sources">
      <Text type="secondary" className="sources-label">Sources</Text>
      {/* Phase 9.6: the same numbers that appear in the answer, e.g. [1]. */}
      {sources.map((s) => (
        <Tooltip key={`${s.n}-${s.source}`} title={s.source}>
          <div className="source">
            <span className="source-n">{s.n}</span>
            <span className="source-text">{s.section}</span>
          </div>
        </Tooltip>
      ))}
    </div>
  );
}

function Usage({ usage }) {
  if (!usage) return null;
  return (
    <>
      <Text type="secondary" className="small usage">
        {usage.totalTokens.toLocaleString()} / {usage.contextWindow.toLocaleString()} tokens
        {/* Multi-agent: what the whole question cost across all model calls. */}
        {usage.llmCalls != null && ` · ${usage.llmCalls} model calls, ${usage.allCallsTokens.toLocaleString()} in total`}
      </Text>
      {usage.warningLevel && (
        <Alert type={usage.warningLevel === "critical" ? "error" : "warning"} showIcon title={usage.warningMessage} className="slim" />
      )}
    </>
  );
}

// The time a message was sent, small and faint; the full date on hover or tap.
function Stamp({ at, align }) {
  if (!at) return null;
  return (
    <Tooltip title={fullTime(at)} trigger={["hover", "click"]}>
      <time className={`stamp ${align ?? ""}`} dateTime={new Date(at).toISOString()}>
        {shortTime(at)}
      </time>
    </Tooltip>
  );
}

export default function Message({ m, streaming, isDark, compact }) {
  const { token } = theme.useToken();
  const { message } = AntApp.useApp();

  if (m.role === "user") {
    return (
      <Bubble
        placement="end"
        shape="corner"
        content={m.text}
        styles={{ content: { background: token.colorPrimary, color: "#fff", whiteSpace: "pre-wrap", maxWidth: compact ? "88vw" : 640 } }}
        header={m.attachment ? <FileTag name={m.attachment} /> : undefined}
        footer={<Stamp at={m.at} align="end" />}
        footerPlacement="outer-end"
      />
    );
  }

  const waiting = streaming && !m.text && !m.error;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(m.text);
      message.success("Copied");
    } catch {
      message.error("Could not copy");
    }
  };

  return (
    <Bubble
      placement="start"
      variant="borderless"
      avatar={compact ? undefined : <Avatar src="/favicon.svg" size={32} />}
      header={<ProcessChips m={m} />}
      loading={waiting}
      content={m.text}
      styles={{ content: { padding: 0, background: "transparent", width: "100%" }, body: { minWidth: 0, flex: 1 } }}
      contentRender={(text) => (
        <>
          {text && (
            <XMarkdown
              content={text}
              className={`answer ${isDark ? "x-markdown-dark" : "x-markdown-light"}`}
              streaming={{ hasNextChunk: streaming }}
              openLinksInNewTab
            />
          )}
          {m.error && <Alert type="warning" showIcon icon={<WarningFilled />} title={m.error} className="slim" />}
        </>
      )}
      footer={
        !waiting && (
          <div className="answer-foot">
            <Sources sources={m.sources} />
            {m.notices?.map((text) => (
              // Phase 10: e.g. "openai/gpt-oss-120b stood in for ..."
              <Alert key={text} type="info" showIcon icon={<MinusCircleOutlined />} title={text} className="slim" />
            ))}
            <div className="answer-actions">
              <Stamp at={m.at} />
              {m.text && !streaming && (
                <Tooltip title="Copy answer">
                  <Button type="text" size="small" icon={<CopyOutlined />} onClick={copy} aria-label="Copy answer" />
                </Tooltip>
              )}
              <Usage usage={m.usage} />
            </div>
          </div>
        )
      }
    />
  );
}
