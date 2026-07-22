import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { InputCopy } from "@/components/ui/input-copy";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipProvider } from "@/components/ui/tooltip";
import { TabsSubtle, TabsSubtleItem } from "@/components/ui/tabs-subtle";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { InputField, InputGroup } from "@/components/ui/input-group";
import { InputCopy as PublishUrlCopy } from "@/components/ui/input-copy";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { ThinkingIndicator } from "@/components/ui/thinking-indicator";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Elevated } from "@/lib/elevated";
import {
  TerminalAnimationCommandBar,
  TerminalAnimationContent,
  TerminalAnimationOutput,
  TerminalAnimationRoot,
  TerminalAnimationWindow,
  type TabContent,
} from "@/components/ui/terminal-animation";

type Project = { id: string; name: string; ts: number };
type Version = { id: string; label: string; ts: number };
type Comment = {
  id: string;
  version_id: string | null;
  author: string;
  text: string;
  anchor: string | null;
  ts: number;
};
type DbState = { versions: Version[]; comments: Comment[] };
type UpdatePayload = { projectId: string; state: DbState; focusId?: string };

const RENDER_CMD = 'lucius render diagram.html "first iteration"';

type SelectionInfo = { selector: string; tag: string; text: string };

// Injected into every rendered artifact: an element picker that highlights on
// hover and reports the clicked element to the shell via postMessage. Armed
// only while select-mode is on, so it never fights the artifact's own JS.
const PICKER_SCRIPT = `<script>(function(){
  var mode=false,hoverEl=null,prevOutline="",prevOffset="";
  function clear(){if(hoverEl){hoverEl.style.outline=prevOutline;hoverEl.style.outlineOffset=prevOffset;hoverEl=null;}}
  window.addEventListener("message",function(e){
    if(e.data&&e.data.type==="lucius:mode"){mode=!!e.data.on;if(!mode)clear();}
  });
  document.addEventListener("mousemove",function(e){
    if(!mode)return;var t=e.target;if(!(t instanceof Element)||t===hoverEl)return;
    clear();hoverEl=t;prevOutline=t.style.outline;prevOffset=t.style.outlineOffset;
    t.style.outline="2px solid #C2410C";t.style.outlineOffset="2px";
  },true);
  document.addEventListener("click",function(e){
    if(!mode)return;e.preventDefault();e.stopPropagation();
    var t=e.target;if(!(t instanceof Element))return;
    var path=[],n=t;
    while(n&&n.nodeType===1&&path.length<7){
      var s=n.tagName.toLowerCase();
      if(n.id){path.unshift(s+"#"+n.id);break;}
      var p=n.parentElement;
      if(p){var sib=Array.prototype.filter.call(p.children,function(c){return c.tagName===n.tagName;});
        if(sib.length>1)s+=":nth-of-type("+(sib.indexOf(n)+1)+")";}
      path.unshift(s);n=p;
    }
    parent.postMessage({type:"lucius:selected",payload:{
      selector:path.join(" > "),
      tag:t.tagName.toLowerCase(),
      text:(t.textContent||"").trim().replace(/\\s+/g," ").slice(0,160)
    }},"*");
  },true);
})()<\/script>`;

const DEMO_TABS: TabContent[] = [
  {
    label: "render",
    command: RENDER_CMD,
    lines: [
      { text: "", delay: 200 },
      { text: '{"id":"v1","label":"first iteration"}', color: "text-neutral-400", delay: 350 },
      { text: "", delay: 150 },
      { text: "→ on the canvas. every push is a new immutable version.", color: "text-neutral-500", delay: 250 },
    ],
  },
];

const timeAgo = (ts: number) => {
  const s = Math.max(1, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return new Date(ts).toLocaleDateString([], { month: "short", day: "numeric" });
};

export default function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProject, setActiveProject] = useState<string>("default");
  const [state, setState] = useState<DbState>({ versions: [], comments: [] });
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [live, setLive] = useState(true);
  const [html, setHtml] = useState<string | null>(null);
  const [port, setPort] = useState<number | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [selectMode, setSelectMode] = useState(false);
  const [selection, setSelection] = useState<SelectionInfo | null>(null);
  const [pubOpen, setPubOpen] = useState(false);
  const [pubHost, setPubHost] = useState<string | null>(null);
  const [pubUrl, setPubUrl] = useState<string | null>(null);
  const [pubBusy, setPubBusy] = useState(false);
  const [pubError, setPubError] = useState<string | null>(null);
  const [webNews, setWebNews] = useState<{ project: string; count: number } | null>(null);
  const [acl, setAcl] = useState<{ visibility: string; members: string[] } | null>(null);
  const [inviteDraft, setInviteDraft] = useState("");
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const liveRef = useRef(live);
  liveRef.current = live;
  const activeRef = useRef(activeProject);
  activeRef.current = activeProject;
  const currentIdRef = useRef(currentId);
  currentIdRef.current = currentId;

  useEffect(() => {
    invoke<Project[]>("get_projects").then(setProjects);
    invoke<{ port: number } | null>("server_info").then((info) => {
      if (info) setPort(info.port);
    });
    const unUpdate = listen<UpdatePayload>("lucius://update", (e) => {
      if (e.payload.projectId !== activeRef.current) {
        // an explicit render/focus in another project pulls the app there
        if (e.payload.focusId) setActiveProject(e.payload.projectId);
        return;
      }
      setState(e.payload.state);
      if (e.payload.focusId && liveRef.current) {
        setCurrentId(e.payload.focusId);
      }
    });
    const unProjects = listen<{ projects: Project[] }>(
      "lucius://projects",
      (e) => setProjects(e.payload.projects),
    );
    invoke<{ host: string } | null>("publish_config").then((c) =>
      setPubHost(c ? c.host : null),
    );
    const unRemote = listen<{ projectId: string; count: number }>(
      "lucius://remote-comments",
      (e) => {
        setWebNews({ project: e.payload.projectId, count: e.payload.count });
        setTimeout(() => setWebNews(null), 10000);
      },
    );
    const onPickerMessage = (e: MessageEvent) => {
      if (e.data?.type !== "lucius:selected") return;
      const sel = e.data.payload as SelectionInfo;
      setSelection(sel);
      invoke("set_selection", {
        project: activeRef.current,
        versionId: currentIdRef.current,
        selector: sel.selector,
        tag: sel.tag,
        text: sel.text,
      });
    };
    window.addEventListener("message", onPickerMessage);
    return () => {
      unUpdate.then((f) => f());
      unProjects.then((f) => f());
      unRemote.then((f) => f());
      window.removeEventListener("message", onPickerMessage);
    };
  }, []);

  // arm/disarm the picker inside the iframe whenever mode or document changes
  useEffect(() => {
    iframeRef.current?.contentWindow?.postMessage(
      { type: "lucius:mode", on: selectMode },
      "*",
    );
  }, [selectMode, html]);

  const clearSelection = useCallback(() => {
    setSelection(null);
    invoke("clear_selection");
  }, []);

  const openPublish = useCallback(async () => {
    setPubError(null);
    setAcl(null);
    const prev = await invoke<{ url: string } | null>("publish_status", {
      project: activeProject,
    });
    setPubUrl(prev?.url ?? null);
    setPubOpen(true);
    if (prev?.url) {
      invoke<{ visibility: string; members: string[] }>("get_acl", {
        project: activeProject,
      })
        .then(setAcl)
        .catch(() => setAcl(null));
    }
  }, [activeProject]);

  const saveAcl = useCallback(
    async (visibility: string, members: string[]) => {
      setAcl({ visibility, members });
      try {
        await invoke("set_acl", { project: activeProject, visibility, members });
      } catch (e) {
        setPubError(String(e));
      }
    },
    [activeProject],
  );

  const doPublish = useCallback(async () => {
    setPubBusy(true);
    setPubError(null);
    try {
      const url = await invoke<string>("publish_project", {
        project: activeProject,
      });
      setPubUrl(url);
    } catch (e) {
      setPubError(String(e));
    } finally {
      setPubBusy(false);
    }
  }, [activeProject]);

  // load state whenever the active project changes
  useEffect(() => {
    setHtml(null);
    setCurrentId(null);
    setLive(true);
    invoke<DbState>("get_state", { project: activeProject }).then((s) => {
      setState(s);
      const latest = s.versions.at(-1);
      setCurrentId(latest ? latest.id : null);
    });
  }, [activeProject]);

  useEffect(() => {
    if (!currentId) {
      setHtml(null);
      return;
    }
    invoke<string | null>("get_version_html", {
      project: activeProject,
      id: currentId,
    }).then(setHtml);
  }, [currentId, activeProject]);

  const createProject = useCallback(async () => {
    const name = newName.trim();
    if (!name) return;
    setNewName("");
    setNewOpen(false);
    const p = await invoke<Project>("create_project", { name });
    setActiveProject(p.id);
  }, [newName]);

  const selectVersion = useCallback((id: string, isLatest: boolean) => {
    setCurrentId(id);
    setLive(isLatest);
  }, []);

  const goLive = useCallback(() => {
    setLive(true);
    const latest = state.versions.at(-1);
    if (latest) setCurrentId(latest.id);
  }, [state.versions]);

  const latest = state.versions.at(-1);

  return (
    <TooltipProvider>
      <div className="flex h-screen flex-col bg-surface-1 text-foreground">
        <header className="flex h-12 shrink-0 items-center gap-2.5 px-4">
          <LogoMark />
          <span className="text-[14px] font-semibold tracking-tight">
            lucius
          </span>
          <Tooltip content={port ? "connected" : "starting…"} side="bottom">
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                port ? "bg-emerald-500" : "bg-amber-400"
              }`}
            />
          </Tooltip>
          <div className="ml-2 flex min-w-0 items-center gap-1">
            <TabsSubtle
              selectedIndex={Math.max(
                0,
                projects.findIndex((p) => p.id === activeProject),
              )}
              onSelect={(i) => {
                const p = projects[i];
                if (p) setActiveProject(p.id);
              }}
            >
              {projects.map((p, i) => (
                <TabsSubtleItem key={p.id} index={i} label={p.name} />
              ))}
            </TabsSubtle>
            <Tooltip content="New project" side="bottom">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="New project"
                onClick={() => setNewOpen(true)}
              >
                <PlusIcon />
              </Button>
            </Tooltip>
          </div>
          <div className="ml-auto flex items-center gap-2">
            {webNews && (
              <Badge variant="dot" color="green" size="sm">
                {webNews.count} new web comment{webNews.count > 1 ? "s" : ""} ·{" "}
                {webNews.project}
              </Badge>
            )}
            {selection && (
              <Tooltip content={`selected: ${selection.selector}`} side="bottom">
                <Badge variant="dot" color="orange" size="sm">
                  <span className="max-w-48 truncate">
                    {selection.tag}
                    {selection.text ? ` · ${selection.text}` : ""}
                  </span>
                  <button
                    aria-label="Clear selection"
                    className="ml-1 opacity-60 hover:opacity-100"
                    onClick={clearSelection}
                  >
                    ×
                  </button>
                </Badge>
              </Tooltip>
            )}
            {html && (
              <Tooltip
                content="Select an element on the canvas to talk about it"
                side="bottom"
              >
                <Button
                  size="sm"
                  variant={selectMode ? "primary" : "tertiary"}
                  onClick={() => setSelectMode((m) => !m)}
                >
                  {selectMode ? "Selecting…" : "Select"}
                </Button>
              </Tooltip>
            )}
            {state.versions.length > 0 && (
              <Tooltip content="Publish this project to the web" side="bottom">
                <Button size="sm" variant="tertiary" onClick={openPublish}>
                  <CloudIcon /> Publish
                </Button>
              </Tooltip>
            )}
            {currentId && (
              <Tooltip
                content={live ? "following latest" : "viewing an older version"}
                side="bottom"
              >
                <Badge variant="dot" color={live ? "green" : "amber"} size="sm">
                  {currentId}
                  {latest && currentId !== latest.id ? ` · ${latest.id} is latest` : ""}
                </Badge>
              </Tooltip>
            )}
            {!live && (
              <Button size="sm" variant="primary" onClick={goLive}>
                Go live
              </Button>
            )}
          </div>
        </header>

        <div className="flex min-h-0 flex-1 gap-3 px-3 pb-3">
          {/* versions rail */}
          <Elevated
            offset={2}
            className="flex w-56 shrink-0 flex-col overflow-hidden rounded-xl"
          >
            <div className="flex items-baseline justify-between px-3.5 pb-2 pt-3">
              <span className="text-[12px] font-medium text-muted-foreground">
                Versions
              </span>
              <span className="text-[11px] tabular-nums text-muted-foreground/70">
                {state.versions.length}
              </span>
            </div>
            <ScrollArea className="min-h-0 w-full flex-1 [&_[data-radix-scroll-area-viewport]>div]:!block">
              <div className="flex w-full flex-col gap-0.5 p-1.5">
                {[...state.versions].reverse().map((v) => {
                  const isLatest = v.id === latest?.id;
                  const isCurrent = v.id === currentId;
                  return (
                    <button
                      key={v.id}
                      onClick={() => selectVersion(v.id, isLatest)}
                      className={`flex w-full min-w-0 flex-col gap-0.5 overflow-hidden rounded-lg px-2.5 py-2 text-left transition-colors ${
                        isCurrent
                          ? "bg-surface-4 shadow-surface-1"
                          : "hover:bg-surface-3"
                      }`}
                    >
                      <span className="flex items-center gap-1.5">
                        <span className="text-[12px] font-semibold">
                          {v.id}
                        </span>
                        {isLatest && (
                          <Badge variant="dot" color="green" size="sm">
                            latest
                          </Badge>
                        )}
                      </span>
                      <span className="truncate text-[12px] text-muted-foreground">
                        {v.label}
                      </span>
                      <span className="text-[10px] tabular-nums text-muted-foreground/60">
                        {timeAgo(v.ts)}
                      </span>
                    </button>
                  );
                })}
              </div>
            </ScrollArea>
          </Elevated>

          {/* canvas */}
          <Elevated
            offset={3}
            className="min-w-0 flex-1 overflow-hidden rounded-xl"
          >
            {html ? (
              <iframe
                ref={iframeRef}
                title={currentId ?? "canvas"}
                sandbox="allow-scripts"
                srcDoc={html + PICKER_SCRIPT}
                onLoad={() =>
                  iframeRef.current?.contentWindow?.postMessage(
                    { type: "lucius:mode", on: selectMode },
                    "*",
                  )
                }
                className="h-full w-full border-0 bg-white"
              />
            ) : (
              <div className="flex h-full items-center justify-center p-8">
                <Card className="w-full max-w-md border-0 shadow-none">
                  <CardHeader className="text-center">
                    <CardTitle className="text-[15px]">
                      Nothing on the canvas yet
                    </CardTitle>
                    <CardDescription>
                      Ask Claude to push an iteration — any self-contained HTML
                      one-pager lands here as a new version.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="flex flex-col gap-4">
                    <TerminalAnimationRoot
                      tabs={DEMO_TABS}
                      alwaysDark
                      hideCursorOnComplete
                    >
                      <TerminalAnimationWindow
                        animateOnVisible={false}
                        minHeight="9rem"
                        className="rounded-xl font-mono text-[12px]"
                      >
                        <TerminalAnimationContent className="px-4 py-4 text-left sm:px-4 sm:py-4">
                          <div className="flex text-neutral-100">
                            <span className="mr-2 text-neutral-500">$</span>
                            <TerminalAnimationCommandBar />
                          </div>
                          <TerminalAnimationOutput
                            className="mt-1"
                            renderLine={(line, _i, visible) =>
                              visible ? (
                                <span className={line.color}>
                                  {line.text || " "}
                                </span>
                              ) : null
                            }
                          />
                        </TerminalAnimationContent>
                      </TerminalAnimationWindow>
                    </TerminalAnimationRoot>
                    <InputCopy value={RENDER_CMD} />
                  </CardContent>
                </Card>
              </div>
            )}
          </Elevated>
        </div>

        <Dialog open={pubOpen} onOpenChange={setPubOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Publish “{activeProject}” to the web</DialogTitle>
            </DialogHeader>
            {pubHost ? (
              <div className="flex flex-col gap-3">
                <p className="text-[13px] text-muted-foreground">
                  Publishes all {state.versions.length} version
                  {state.versions.length > 1 ? "s" : ""} to your Cloudflare
                  Worker (<span className="font-medium">{pubHost}</span>).
                  Viewers sign in with GitHub to leave comments; new comments
                  flow back here automatically.
                </p>
                {pubUrl && !pubBusy && (
                  <div className="flex items-center gap-2">
                    <PublishUrlCopy value={pubUrl} className="min-w-0 flex-1" />
                    <Button
                      size="sm"
                      variant="tertiary"
                      onClick={() => openUrl(pubUrl)}
                    >
                      Open
                    </Button>
                  </div>
                )}
                {pubBusy && (
                  <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
                    <ThinkingIndicator /> uploading versions…
                  </div>
                )}
                {pubUrl && acl && (
                  <div className="flex flex-col gap-2 rounded-xl bg-surface-2 p-3">
                    <div className="flex items-center justify-between">
                      <div className="flex flex-col">
                        <span className="text-[13px] font-medium">
                          Private — invited members only
                        </span>
                        <span className="text-[11.5px] text-muted-foreground">
                          {acl.visibility === "private"
                            ? "Only the GitHub users below can view & comment"
                            : "Anyone with the link can view & comment"}
                        </span>
                      </div>
                      <Switch
                        label=""
                        checked={acl.visibility === "private"}
                        onToggle={() =>
                          saveAcl(
                            acl.visibility === "private" ? "link" : "private",
                            acl.members,
                          )
                        }
                      />
                    </div>
                    {acl.visibility === "private" && (
                      <>
                        <div className="flex flex-wrap gap-1.5">
                          {acl.members.length === 0 && (
                            <span className="text-[12px] text-muted-foreground">
                              no members yet — invite by GitHub username
                            </span>
                          )}
                          {acl.members.map((m) => (
                            <Badge key={m} variant="dot" color="gray" size="sm">
                              @{m}
                              <button
                                aria-label={`Remove ${m}`}
                                className="ml-1 opacity-60 hover:opacity-100"
                                onClick={() =>
                                  saveAcl(
                                    acl.visibility,
                                    acl.members.filter((x) => x !== m),
                                  )
                                }
                              >
                                ×
                              </button>
                            </Badge>
                          ))}
                        </div>
                        <form
                          className="flex items-center gap-2"
                          onSubmit={(e) => {
                            e.preventDefault();
                            const u = inviteDraft.trim().replace(/^@/, "").toLowerCase();
                            if (!u) return;
                            setInviteDraft("");
                            saveAcl(acl.visibility, [
                              ...new Set([...acl.members, u]),
                            ]);
                          }}
                        >
                          <Input
                            value={inviteDraft}
                            onChange={(e) => setInviteDraft(e.target.value)}
                            placeholder="github-username"
                            className="h-8 text-[13px]"
                          />
                          <Button type="submit" size="sm" variant="tertiary">
                            Invite
                          </Button>
                        </form>
                      </>
                    )}
                  </div>
                )}
                {pubError && (
                  <p className="text-[13px] text-red-600">{pubError}</p>
                )}
                <DialogFooter>
                  <Button
                    size="sm"
                    variant="tertiary"
                    onClick={() => setPubOpen(false)}
                  >
                    Close
                  </Button>
                  <Button size="sm" onClick={doPublish} disabled={pubBusy}>
                    {pubUrl ? "Publish update" : "Publish"}
                  </Button>
                </DialogFooter>
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                <p className="text-[13px] text-muted-foreground">
                  Connect your Cloudflare account first — lucius deploys its
                  own Worker + R2 bucket there (free tier), once. Run{" "}
                  <code className="rounded bg-muted px-1">lucius setup</code>{" "}
                  in a terminal (it opens the Cloudflare login in your
                  browser), then come back and publish.
                </p>
                <DialogFooter>
                  <Button
                    size="sm"
                    variant="tertiary"
                    onClick={() => setPubOpen(false)}
                  >
                    Close
                  </Button>
                </DialogFooter>
              </div>
            )}
          </DialogContent>
        </Dialog>

        <Dialog open={newOpen} onOpenChange={setNewOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>New project</DialogTitle>
            </DialogHeader>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                createProject();
              }}
            >
              <InputGroup>
                <InputField
                  index={0}
                  label="Name"
                  placeholder="payments-revamp"
                  value={newName}
                  onChange={setNewName}
                  autoFocus
                />
              </InputGroup>
              <DialogFooter className="mt-4">
                <Button
                  type="button"
                  variant="tertiary"
                  size="sm"
                  onClick={() => setNewOpen(false)}
                >
                  Cancel
                </Button>
                <Button type="submit" size="sm" disabled={!newName.trim()}>
                  Create
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </div>
    </TooltipProvider>
  );
}

function CloudIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden>
      <path
        d="M4.5 12.5 a3 3 0 0 1 -.4-5.97 4 4 0 0 1 7.8 0 A3 3 0 0 1 11.5 12.5 Z M8 11 V7.5 M6.5 9 L8 7.3 L9.5 9"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
      <path
        d="M7 2.5 V11.5 M2.5 7 H11.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

// Logo A — "Strata": stacked version sheets, picked from the v4 board.
function LogoMark() {
  return (
    <svg width="16" height="16" viewBox="0 0 32 32" aria-hidden>
      <rect x="10" y="4" width="18" height="18" rx="4" fill="none" stroke="currentColor" strokeWidth="2" opacity=".35" />
      <rect x="7" y="7" width="18" height="18" rx="4" fill="none" stroke="currentColor" strokeWidth="2" opacity=".6" />
      <rect x="4" y="10" width="18" height="18" rx="4" fill="currentColor" />
    </svg>
  );
}
