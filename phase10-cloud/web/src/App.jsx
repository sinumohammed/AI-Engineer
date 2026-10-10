import { useEffect, useRef, useState } from "react";
import { Alert, App as AntApp, Button, Card, Drawer, Grid, Input, Spin, Tag, Tooltip, Typography, theme } from "antd";
import { Prompts, Sender, Welcome } from "@ant-design/x";
import {
  ArrowDownOutlined,
  BookOutlined,
  CodeOutlined,
  GlobalOutlined,
  MenuOutlined,
  PlusOutlined,
  SplitCellsOutlined,
} from "@ant-design/icons";
import { useChatSession } from "./useChatSession.js";
import Sidebar, { AGENT_LABELS, Brand } from "./Sidebar.jsx";
import Message from "./Message.jsx";
import VoiceBar, { MicButton } from "./VoiceBar.jsx";
import { useVoiceInput, voiceSupported } from "./useVoiceInput.js";
import { dayLabel, sameDay } from "./time.js";
import { AttachButton, AttachmentChip, MAX_UPLOAD, prepareFile } from "./Attachment.jsx";

const { Text } = Typography;

// Phase 10 UI: one layout for every screen size.
//   desktop and tablet in landscape (lg, 992px and up): settings in a sidebar
//   phone and tablet in portrait: settings in a drawer behind the menu button
// Everything the old single-card page showed is still here: both modes, the
// specialist override, search and routing chips, sources, notices, token use.

// A setting remembered in this browser.
function useStoredValue(key, initial) {
  const [value, setValue] = useState(() => {
    try {
      return localStorage.getItem(key) ?? initial;
    } catch {
      return initial;
    }
  });
  const set = (v) => {
    setValue(v);
    try {
      localStorage.setItem(key, v);
    } catch {
      // storage blocked: lasts until the page closes
    }
  };
  return [value, set];
}

function useStoredFlag(key, initial) {
  const [value, setValue] = useState(() => {
    try {
      const v = localStorage.getItem(key);
      return v === null ? initial : v === "1";
    } catch {
      return initial;
    }
  });
  const set = (v) => {
    setValue(v);
    try {
      localStorage.setItem(key, v ? "1" : "0");
    } catch {
      // storage blocked: lasts until the page closes
    }
  };
  return [value, set];
}

export default function App({ themeMode, setThemeMode, isDark }) {
  const { state, ask, stop, newChat, setMode, setAgent, access, submitCode, voice: voiceOnServer, attach, detach } = useChatSession();
  const { message } = AntApp.useApp();
  const screens = Grid.useBreakpoint();
  const wide = Boolean(screens.lg);
  const compact = !screens.sm; // phones
  const { token } = theme.useToken();
  const [input, setInput] = useState("");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const scrollRef = useRef(null);
  const nearBottom = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const [reading, setReading] = useState(null); // name of a file being uploaded and read

  // Follow the answer as it streams in - unless the user has scrolled up to
  // read something, then leave them there and offer a jump-down button.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && nearBottom.current) el.scrollTop = el.scrollHeight;
  }, [state.messages]);

  function onScroll() {
    const el = scrollRef.current;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    nearBottom.current = near;
    setShowJump(!near);
  }

  function jumpDown() {
    const el = scrollRef.current;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }

  function send(text) {
    const q = text.trim();
    if (!q || state.busy) return;
    // Found by the user: asked while a new file was still being read, the
    // question went out with the previous file.
    if (reading) return message.info(`Still reading ${reading} - send your question in a moment.`);
    nearBottom.current = true;
    ask(q);
    setInput("");
  }

  // Phase 10 UI: voice input. The text goes into the box to check and send -
  // or straight out, if "Send as soon as I stop talking" is on.
  const [voiceAutoSend, setVoiceAutoSend] = useStoredFlag("voiceAutoSend", false);
  const [voiceLanguage, setVoiceLanguage] = useStoredValue("voiceLanguage", "auto");
  const canSpeak = voiceOnServer && voiceSupported();
  const voice = useVoiceInput({
    onText: (text) => {
      if (voiceAutoSend && !state.busy && !input.trim()) return send(text);
      setInput((prev) => (prev.trim() ? `${prev.trimEnd()} ${text}` : text));
    },
    onError: (msg) => message.warning(msg),
    language: voiceLanguage,
  });

  // Phase 10, attachments: shrink photos, upload, show "Reading..." meanwhile.
  async function pickFile(file) {
    if (file.type !== "application/pdf" && !file.type.startsWith("image/")) return message.warning("Attach a PDF or a photo.");
    setReading(file.name);
    try {
      const ready = await prepareFile(file);
      if (ready.size > MAX_UPLOAD) throw new Error("That file is too big - attachments can be up to 4 MB.");
      const att = await attach(ready);
      message.success(att.kind === "image" ? "Photo attached - ask about it" : `${att.pages}-page PDF attached - ask about it`);
    } catch (err) {
      message.warning(err.message === "Failed to fetch" ? "Connection lost - check your internet and try again." : err.message);
    } finally {
      setReading(null);
    }
  }

  // Phase 10 step 6: the hosted API needs an access code before anything else.
  if (access.needed) return <AccessScreen wrong={access.wrong} onSubmit={submitCode} />;

  const cssVars = {
    "--bg": token.colorBgLayout,
    "--panel": token.colorBgContainer,
    "--border": token.colorBorderSecondary,
    "--muted": token.colorTextSecondary,
    "--primary": token.colorPrimary,
    "--primary-soft": token.colorPrimaryBg,
    "--fill": token.colorFillQuaternary,
  };
  const sidebar = (
    <Sidebar
      state={state}
      newChat={newChat}
      setMode={setMode}
      setAgent={setAgent}
      themeMode={themeMode}
      setThemeMode={setThemeMode}
      canSpeak={canSpeak}
      voiceAutoSend={voiceAutoSend}
      setVoiceAutoSend={setVoiceAutoSend}
      voiceLanguage={voiceLanguage}
      setVoiceLanguage={setVoiceLanguage}
      hasAttachment={Boolean(state.attachment)}
      onDone={() => setDrawerOpen(false)}
    />
  );
  const lastIndex = state.messages.length - 1;
  const usage = state.usage;
  const percent = usage ? Math.min(100, Math.round((usage.totalTokens / usage.contextWindow) * 100)) : 0;
  const overriding = state.mode === "multi" && state.agent !== "auto";

  return (
    <div className="app" style={cssVars}>
      {wide && <aside className="sidebar">{sidebar}</aside>}

      <main className="main">
        <header className="topbar">
          {!wide && (
            <Button type="text" icon={<MenuOutlined />} onClick={() => setDrawerOpen(true)} aria-label="Menu" />
          )}
          {!wide && <Brand compact />}
          {wide && (
            <Text strong className="topbar-title">
              {state.mode === "multi" ? "Multi-agent" : "Single agent"}
            </Text>
          )}
          <div className="grow" />
          {usage && (
            <Tooltip title={`Context used: ${usage.totalTokens.toLocaleString()} of ${usage.contextWindow.toLocaleString()} tokens`}>
              <Tag
                variant="filled"
                color={usage.warningLevel === "critical" ? "error" : usage.warningLevel === "warning" ? "warning" : "default"}
                className="ctx-tag"
              >
                {percent}% context
              </Tag>
            </Tooltip>
          )}
          {!wide && (
            <Button type="text" icon={<PlusOutlined />} onClick={newChat} disabled={state.busy} aria-label="New chat" />
          )}
        </header>

        <div className="scroll" ref={scrollRef} onScroll={onScroll}>
          <div className="thread">
            {!state.loaded && (
              <div className="center">
                <Spin />
              </div>
            )}
            {state.loaded && state.messages.length === 0 && <WelcomeScreen onPick={send} compact={compact} mode={state.mode} />}
            {state.messages.map((m, i) => {
              // A "Today" / "Yesterday" / "Fri, 8 Oct" divider where the day
              // changes (only between messages that have a time).
              const prevAt = state.messages.slice(0, i).reverse().find((p) => p.at)?.at;
              const newDay = m.role === "user" && m.at && (!prevAt || !sameDay(prevAt, m.at));
              return (
                <div key={i} className="msg">
                  {newDay && <div className="day-divider"><span>{dayLabel(m.at)}</span></div>}
                  <Message m={m} streaming={state.busy && i === lastIndex} isDark={isDark} compact={compact} />
                </div>
              );
            })}
          </div>
        </div>

        {showJump && (
          <Button className="jump" shape="circle" icon={<ArrowDownOutlined />} onClick={jumpDown} aria-label="Scroll to the latest message" />
        )}

        <div className="composer">
          <div className="composer-inner">
            {voice.status !== "idle" ? (
              <VoiceBar voice={voice} />
            ) : (
            <Sender
              value={input}
              onChange={setInput}
              onSubmit={send}
              onCancel={stop}
              loading={state.busy}
              placeholder={compact ? "Ask anything…" : "Ask about the handbook, code, or anything else…"}
              autoSize={{ minRows: 1, maxRows: 6 }}
              // 16px on phones: iPhones zoom into any smaller input on focus.
              styles={{ input: { fontSize: compact ? 16 : 15 } }}
              suffix={(actions) => (
                <div className="sender-actions">
                  <AttachButton onPick={pickFile} disabled={Boolean(reading)} />
                  {canSpeak && <MicButton onClick={voice.start} />}
                  {actions}
                </div>
              )}
              header={
                (overriding || state.attachment || reading) && (
                  <div className="override">
                    <AttachmentChip attachment={state.attachment} reading={reading} onRemove={detach} />
                    {overriding && (
                      <Tag color="warning" closable onClose={() => setAgent("auto")}>
                        Asking {AGENT_LABELS[state.agent]} directly
                      </Tag>
                    )}
                  </div>
                )
              }
            />
            )}
            {!compact && (
              <Text type="secondary" className="hint">
                Enter to send · Shift + Enter for a new line{canSpeak ? " · mic to speak" : ""} · answers can be wrong, check the sources
              </Text>
            )}
          </div>
        </div>
      </main>

      <Drawer
        open={drawerOpen && !wide}
        onClose={() => setDrawerOpen(false)}
        placement="left"
        size={compact ? "86vw" : 340}
        closable={false}
        styles={{ body: { padding: 0 } }}
      >
        {sidebar}
      </Drawer>
    </div>
  );
}

function WelcomeScreen({ onPick, compact, mode }) {
  const items = [
    {
      key: "handbook",
      icon: <BookOutlined style={{ color: "#6d5ff5" }} />,
      label: "Company handbook",
      description: "How much paid parental leave do I get?",
    },
    {
      key: "fmla",
      icon: <BookOutlined style={{ color: "#6d5ff5" }} />,
      label: "Leave rules",
      description: "Who is eligible for FMLA?",
    },
    {
      key: "code",
      icon: <CodeOutlined style={{ color: "#0ea5e9" }} />,
      label: "Coding",
      description: "How do I list all git tags?",
    },
    {
      key: "two",
      icon: <SplitCellsOutlined style={{ color: "#f59e0b" }} />,
      label: mode === "multi" ? "Two questions at once" : "Two questions (try Multi-agent)",
      description: "What is our rollback process, and how do I list git tags?",
    },
    {
      key: "lang",
      icon: <GlobalOutlined style={{ color: "#10b981" }} />,
      label: "Any language",
      description: "കോമ്പ് ടൈം എപ്പോഴാണ് കാലഹരണപ്പെടുന്നത്?",
    },
  ];
  return (
    <div className="welcome">
      <Welcome
        variant="borderless"
        icon={<img src="/favicon.svg" alt="" width={compact ? 44 : 56} height={compact ? 44 : 56} />}
        styles={compact ? { title: { fontSize: 22, lineHeight: 1.25 }, description: { fontSize: 14.5 } } : undefined}
        title="Hi, what would you like to know?"
        description="I answer from the company handbook when it covers your question, and cite the sections I used. Coding and general questions work too."
      />
      <Prompts
        title="Try one of these"
        items={items}
        vertical={compact}
        wrap={!compact}
        onItemClick={({ data }) => onPick(String(data.description))}
        styles={{ item: compact ? { width: "100%" } : { flex: "1 1 220px" } }}
      />
    </div>
  );
}

function AccessScreen({ wrong, onSubmit }) {
  const [code, setCode] = useState("");
  const { token } = theme.useToken();
  return (
    <div className="access" style={{ background: token.colorBgLayout }}>
      <Card className="access-card">
        <Brand />
        <Text type="secondary">This app runs on free model quotas, so it is not open to everyone. Enter the access code you were given.</Text>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (code.trim()) onSubmit(code);
          }}
          className="access-form"
        >
          <Input.Password
            autoFocus
            size="large"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="Access code"
            status={wrong ? "error" : undefined}
            style={{ fontSize: 16 }}
          />
          {wrong && <Alert type="error" showIcon title="That code was not accepted." className="slim" />}
          <Button type="primary" size="large" htmlType="submit" block>
            Continue
          </Button>
        </form>
      </Card>
    </div>
  );
}
