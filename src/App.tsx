import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { motion, AnimatePresence } from "framer-motion";
import { ThinkingOrb } from "thinking-orbs";
import { spring } from "@/lib/springs";
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
import { Textarea } from "@/components/ui/textarea";
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
type SessionStatus = { state: string; detail: string; ts: number };
type OrbState = "working" | "searching" | "solving" | "listening" | "composing" | "shaping";
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
// injected into every artifact: keep text selection in the monochrome world
const CANVAS_STYLE = `<style>::selection{background:rgba(0,0,0,.14)}</style>`;

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

// Injected alongside the picker: tdoc-style highlight commenting inside the
// sandboxed iframe. Highlight text -> a Comment pill appears -> the shell
// composes; existing text-anchored comments render as underline highlights
// (located by exact text + surrounding context, drawn as overlay boxes so no
// DOM surgery touches the artifact). All coordination via postMessage.
const ANNOTATE_SCRIPT = `<script>(function(){
  var marks=[],pill=null;
  function rmPill(){if(pill){pill.remove();pill=null;}}
  function clearMarks(){marks.forEach(function(m){m.remove()});marks=[];}
  function docText(){
    var w=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT),parts=[],nodes=[],pos=0,n;
    while((n=w.nextNode())){parts.push(n.nodeValue);nodes.push({node:n,start:pos});pos+=n.nodeValue.length;}
    return {text:parts.join(""),nodes:nodes};
  }
  function locate(anchor){
    var d=docText(),hay=d.text,needle=anchor.text;
    if(!needle)return null;
    var idx=-1;
    if(anchor.context_before||anchor.context_after){
      var probe=(anchor.context_before||"")+needle+(anchor.context_after||"");
      var pi=hay.indexOf(probe);
      if(pi>=0)idx=pi+(anchor.context_before||"").length;
    }
    if(idx<0)idx=hay.indexOf(needle);
    if(idx<0)return null;
    function at(off){
      for(var i=d.nodes.length-1;i>=0;i--){
        if(d.nodes[i].start<=off)return {node:d.nodes[i].node,off:off-d.nodes[i].start};
      }
      return null;
    }
    var s=at(idx),e=at(idx+needle.length);
    if(!s||!e)return null;
    var r=document.createRange();
    try{r.setStart(s.node,s.off);r.setEnd(e.node,Math.min(e.off,e.node.nodeValue.length));}catch(err){return null;}
    return r;
  }
  function render(items){
    clearMarks();
    items.forEach(function(it){
      var r=locate(it.anchor);if(!r)return;
      var rects=r.getClientRects();
      for(var i=0;i<rects.length;i++){
        var b=rects[i];if(!b.width)continue;
        var m=document.createElement("div");
        m.style.cssText="position:absolute;z-index:2147483000;left:"+(window.scrollX+b.left)+"px;top:"+(window.scrollY+b.top)+"px;width:"+b.width+"px;height:"+b.height+"px;background:rgba(194,65,12,.13);border-bottom:2px solid #C2410C;cursor:pointer;border-radius:2px";
        m.setAttribute("data-cid",it.id);
        m.addEventListener("click",function(ev){
          ev.stopPropagation();
          var rr=this.getBoundingClientRect();
          parent.postMessage({type:"lucius:thread",id:this.getAttribute("data-cid"),rect:{x:rr.left+rr.width/2,y:rr.bottom}},"*");
        });
        document.body.appendChild(m);marks.push(m);
      }
    });
  }
  document.addEventListener("mouseup",function(){
    setTimeout(function(){
      rmPill();
      var sel=window.getSelection();
      if(!sel||sel.isCollapsed||!sel.rangeCount)return;
      var txt=sel.toString();
      if(!txt.trim()||txt.length>2000)return;
      var range=sel.getRangeAt(0),b=range.getBoundingClientRect();
      var d=docText(),idx=d.text.indexOf(txt);
      var anchor={kind:"text",text:txt,
        context_before:idx>0?d.text.slice(Math.max(0,idx-60),idx):"",
        context_after:idx>=0?d.text.slice(idx+txt.length,idx+txt.length+60):""};
      pill=document.createElement("button");
      pill.textContent="Comment";
      pill.style.cssText="position:absolute;z-index:2147483001;left:"+(window.scrollX+b.right-34)+"px;top:"+(window.scrollY+b.bottom+6)+"px;font:600 11px system-ui;background:#1d1b17;color:#fff;border:1px solid #1d1b17;border-radius:999px;padding:4px 12px;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.2)";
      pill.addEventListener("mousedown",function(ev){ev.preventDefault();ev.stopPropagation();});
      pill.addEventListener("click",function(ev){
        ev.stopPropagation();
        var rr=pill.getBoundingClientRect();
        parent.postMessage({type:"lucius:compose",anchor:anchor,rect:{x:rr.left,y:rr.bottom}},"*");
        rmPill();
      });
      document.body.appendChild(pill);
    },0);
  });
  document.addEventListener("mousedown",function(){rmPill();});
  window.addEventListener("message",function(e){
    var d=e.data||{};
    if(d.type==="lucius:comments")render(d.items||[]);
    if(d.type==="lucius:goto-text"){
      var r=locate(d.anchor);
      if(r){var b=r.getBoundingClientRect();
        window.scrollTo({top:window.scrollY+b.top-window.innerHeight/2,behavior:"smooth"});}
    }
  });
  window.addEventListener("resize",function(){parent.postMessage({type:"lucius:needcomments"},"*")});
})()<\/script>`;

type TextAnchor = {
  kind: string;
  text: string;
  context_before?: string;
  context_after?: string;
};

const parseAnchor = (a: string | null): TextAnchor | null => {
  if (!a || !a.startsWith("{")) return null;
  try {
    const j = JSON.parse(a);
    return j && j.kind === "text" && typeof j.text === "string" ? j : null;
  } catch {
    return null;
  }
};

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
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [projectLoading, setProjectLoading] = useState(false);
  const [statuses, setStatuses] = useState<Record<string, SessionStatus>>({});
  const [canvasReady, setCanvasReady] = useState(false);
  const [, forceTick] = useState(0);
  const [compose, setCompose] = useState<{ anchor: TextAnchor; x: number; y: number } | null>(null);
  const [composeText, setComposeText] = useState("");
  const [thread, setThread] = useState<{ id: string; x: number; y: number } | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const liveRef = useRef(live);
  liveRef.current = live;
  const activeRef = useRef(activeProject);
  activeRef.current = activeProject;
  const currentIdRef = useRef(currentId);
  currentIdRef.current = currentId;

  useEffect(() => {
    invoke<Project[]>("get_projects").then(setProjects);
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
    invoke<Record<string, SessionStatus>>("get_statuses").then(setStatuses);
    const unStatus = listen<{ projectId: string; state: string; detail: string; ts: number }>(
      "lucius://status",
      (e) => {
        const { projectId, state: st, detail, ts } = e.payload;
        setStatuses((prev) => {
          const next = { ...prev };
          if (st === "idle") delete next[projectId];
          else next[projectId] = { state: st, detail, ts };
          return next;
        });
      },
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
      const t = e.data?.type;
      if (t === "lucius:selected") {
        const sel = e.data.payload as SelectionInfo;
        setSelection(sel);
        invoke("set_selection", {
          project: activeRef.current,
          versionId: currentIdRef.current,
          selector: sel.selector,
          tag: sel.tag,
          text: sel.text,
        });
        return;
      }
      const frame = iframeRef.current?.getBoundingClientRect();
      if (t === "lucius:compose" && frame) {
        setThread(null);
        setComposeText("");
        setCompose({
          anchor: e.data.anchor as TextAnchor,
          x: frame.left + e.data.rect.x,
          y: frame.top + e.data.rect.y,
        });
        return;
      }
      if (t === "lucius:thread" && frame) {
        setCompose(null);
        setThread({
          id: e.data.id as string,
          x: frame.left + e.data.rect.x,
          y: frame.top + e.data.rect.y,
        });
        return;
      }
      if (t === "lucius:needcomments") {
        pushComments();
      }
    };
    window.addEventListener("message", onPickerMessage);
    return () => {
      unUpdate.then((f) => f());
      unProjects.then((f) => f());
      unRemote.then((f) => f());
      unStatus.then((f) => f());
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

  // send text-anchored comments of the current version into the iframe
  const pushComments = useCallback(() => {
    const s = stateRef.current;
    const items = s.comments
      .filter((c) => !c.version_id || c.version_id === currentIdRef.current)
      .map((c) => ({ id: c.id, anchor: parseAnchor(c.anchor) }))
      .filter((x): x is { id: string; anchor: TextAnchor } => x.anchor !== null);
    iframeRef.current?.contentWindow?.postMessage(
      { type: "lucius:comments", items },
      "*",
    );
  }, []);

  useEffect(() => {
    setCompose(null);
    setThread(null);
    const t = setTimeout(pushComments, 250);
    return () => clearTimeout(t);
  }, [html, currentId, state.comments, pushComments]);

  const submitCompose = useCallback(async () => {
    if (!compose || !composeText.trim()) return;
    const anchor = JSON.stringify(compose.anchor);
    setCompose(null);
    await invoke("add_comment", {
      project: activeProject,
      text: composeText.trim(),
      author: "engineer",
      versionId: currentId,
      anchor,
    });
    setComposeText("");
  }, [compose, composeText, activeProject, currentId]);

  const versionComments = state.comments.filter(
    (c) => !c.version_id || c.version_id === currentId,
  );

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

  // relative timestamps tick once a minute so "3m ago" never goes stale
  useEffect(() => {
    const t = setInterval(() => forceTick((n) => n + 1), 60_000);
    return () => clearInterval(t);
  }, []);

  // load state whenever the active project changes
  useEffect(() => {
    setHtml(null);
    setCurrentId(null);
    setLive(true);
    setProjectLoading(true);
    // a selection made on another project's canvas is meaningless now
    setSelection(null);
    invoke("clear_selection");
    invoke<DbState>("get_state", { project: activeProject }).then((s) => {
      setState(s);
      const latest = s.versions.at(-1);
      setCurrentId(latest ? latest.id : null);
      setProjectLoading(false);
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
    }).then((h) => {
      setCanvasReady(false);
      setHtml(h);
    });
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
      <div className="flex h-dvh flex-col bg-surface-1 text-foreground">
        <header
          data-tauri-drag-region
          className="flex h-12 shrink-0 items-center gap-2.5 pl-[84px] pr-3"
        >
          <LogoMark />
          <span className="text-[14px] font-semibold tracking-tight">
            lucius
          </span>
          <div className="ml-auto flex items-center gap-2">
            <AnimatePresence>
              {webNews && (
                <motion.div
                  initial={{ opacity: 0, x: 8, scale: 0.96 }}
                  animate={{ opacity: 1, x: 0, scale: 1 }}
                  exit={{ opacity: 0, x: 8, scale: 0.96 }}
                  transition={spring.moderate}
                >
                  <Badge variant="dot" color="green" size="sm">
                    {webNews.count} new web comment
                    {webNews.count > 1 ? "s" : ""} · {webNews.project}
                  </Badge>
                </motion.div>
              )}
              {selection && (
                <motion.div
                  key="sel"
                  initial={{ opacity: 0, x: 8, scale: 0.96 }}
                  animate={{ opacity: 1, x: 0, scale: 1 }}
                  exit={{ opacity: 0, x: 8, scale: 0.96 }}
                  transition={spring.moderate}
                >
                  <Tooltip content={`selected: ${selection.selector}`} side="bottom">
                    <span className="flex h-7 items-center gap-1.5 rounded-full border border-border bg-surface-2 pl-2.5 pr-1.5 text-[12px]">
                      <span className="h-1.5 w-1.5 rounded-full bg-[#C2410C]" />
                      <span className="max-w-44 truncate font-mono text-[11px]">
                        {selection.tag}
                        {selection.text ? ` · ${selection.text}` : ""}
                      </span>
                      <button
                        aria-label="Clear selection"
                        className="grid h-4 w-4 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-surface-4 hover:text-foreground"
                        onClick={clearSelection}
                      >
                        ×
                      </button>
                    </span>
                  </Tooltip>
                </motion.div>
              )}
            </AnimatePresence>

            {/* action cluster — same 28px height as the status pill */}
            <div className="flex h-7 items-center gap-px rounded-full border border-border bg-surface-2 px-[3px] shadow-surface-1">
              <Tooltip
                content={selectMode ? "Stop selecting" : "Point at an element to talk about it"}
                side="bottom"
              >
                <Button
                  variant={selectMode ? "primary" : "ghost"}
                  size="icon-sm"
                  aria-label="Select an element"
                  className="h-[22px] w-[22px] rounded-full p-0"
                  disabled={!html}
                  onClick={() => setSelectMode((m) => !m)}
                >
                  <CursorIcon />
                </Button>
              </Tooltip>
              <Tooltip content="Comments" side="bottom">
                <span className="relative inline-flex">
                  <Button
                    variant={commentsOpen ? "primary" : "ghost"}
                    size="icon-sm"
                    aria-label="Comments"
                    className="h-[22px] w-[22px] rounded-full p-0"
                    disabled={!currentId}
                    onClick={() => setCommentsOpen((o) => !o)}
                  >
                    <CommentIcon />
                  </Button>
                  <AnimatePresence>
                    {versionComments.length > 0 && (
                      <motion.span
                        key={versionComments.length}
                        initial={{ opacity: 0, scale: 0.6 }}
                        animate={{ opacity: 1, scale: 1 }}
                        exit={{ opacity: 0, scale: 0.6 }}
                        transition={spring.fast}
                        className="pointer-events-none absolute -right-1 -top-1 grid h-3.5 min-w-3.5 place-items-center rounded-full bg-foreground px-0.5 text-[8.5px] font-semibold tabular-nums leading-none text-background"
                      >
                        {versionComments.length}
                      </motion.span>
                    )}
                  </AnimatePresence>
                </span>
              </Tooltip>
              <Tooltip content="Publish & share" side="bottom">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Publish and share"
                  className="h-[22px] w-[22px] rounded-full p-0"
                  disabled={state.versions.length === 0}
                  onClick={openPublish}
                >
                  <CloudIcon />
                </Button>
              </Tooltip>
            </div>

            {/* version / live status */}
            {currentId && (
              <Tooltip
                content={live ? "following latest" : "click to jump back to latest"}
                side="bottom"
              >
                <motion.button
                  layout
                  whileTap={live ? undefined : { scale: 0.96 }}
                  onClick={live ? undefined : goLive}
                  transition={spring.moderate}
                  className={`flex h-7 items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 text-[12px] font-medium tabular-nums ${
                    live
                      ? "cursor-default border-border bg-surface-2"
                      : "cursor-pointer border-foreground bg-foreground text-background"
                  }`}
                >
                  <span
                    className={`h-1.5 w-1.5 flex-none rounded-full ${
                      live ? "animate-pulse bg-emerald-500" : "bg-amber-400"
                    }`}
                  />
                  <AnimatePresence mode="wait" initial={false}>
                    <motion.span
                      key={live ? `live-${currentId}` : `behind-${currentId}`}
                      initial={{ opacity: 0, y: 4 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -4 }}
                      transition={spring.fast}
                      className="whitespace-nowrap"
                    >
                      {live
                        ? `${currentId} · live`
                        : `${currentId} → go live (${latest?.id})`}
                    </motion.span>
                  </AnimatePresence>
                </motion.button>
              </Tooltip>
            )}
          </div>
        </header>

        <div className="flex min-h-0 flex-1 gap-3 px-3 pb-3">
          {/* layered sidebar: sessions → versions */}
          <Elevated
            offset={2}
            className="flex w-60 shrink-0 flex-col overflow-hidden rounded-xl"
          >
            <div className="flex items-center justify-between py-2 pl-3.5 pr-1.5">
              <span className="text-[10.5px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
                Sessions
              </span>
              <Tooltip content="New session" side="bottom">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="New session"
                  onClick={() => setNewOpen(true)}
                >
                  <PlusIcon />
                </Button>
              </Tooltip>
            </div>
            <ScrollArea className="min-h-0 w-full flex-1 [&_[data-radix-scroll-area-viewport]]:!w-full [&_[data-radix-scroll-area-viewport]>div]:!block [&_[data-radix-scroll-area-viewport]>div]:!min-w-0 [&_[data-radix-scroll-area-viewport]>div]:!w-full">
              <div className="flex w-full flex-col gap-0.5 p-1.5">
                {projects.map((p) => {
                  const isActive = p.id === activeProject;
                  return (
                    <div key={p.id} className="flex w-full flex-col">
                      <motion.button
                        whileTap={{ scale: 0.985 }}
                        transition={spring.fast}
                        onClick={() => setActiveProject(p.id)}
                        className={`group flex w-full items-center gap-1.5 rounded-lg px-2 py-[5px] text-left transition-colors ${
                          isActive ? "bg-surface-3" : "hover:bg-surface-3"
                        }`}
                      >
                        <Chevron open={isActive} />
                        <span
                          className={`truncate text-[12.5px] transition-colors ${
                            isActive
                              ? "font-semibold text-foreground"
                              : "font-medium text-muted-foreground group-hover:text-foreground"
                          }`}
                        >
                          {p.name}
                        </span>
                        <span className="ml-auto flex items-center gap-1.5">
                          {statuses[p.id] && (
                            <Tooltip
                              content={
                                statuses[p.id].detail || statuses[p.id].state
                              }
                              side="right"
                            >
                              <motion.span
                                initial={{ opacity: 0, scale: 0.9 }}
                                animate={{ opacity: 1, scale: 1 }}
                                transition={spring.moderate}
                                className="flex h-[18px] items-center gap-0.5 rounded-full bg-foreground pl-px pr-1.5"
                              >
                                <ThinkingOrb
                                  state={statuses[p.id].state as OrbState}
                                  size={20}
                                  theme="dark"
                                  className="scale-[0.8]"
                                />
                                <span className="text-[9px] font-medium capitalize leading-none text-background">
                                  {statuses[p.id].state}…
                                </span>
                              </motion.span>
                            </Tooltip>
                          )}
                          {isActive && !statuses[p.id] && (
                            <span className="text-[10px] tabular-nums text-muted-foreground/70">
                              {state.versions.length}
                            </span>
                          )}
                        </span>
                      </motion.button>
                      <AnimatePresence initial={false}>
                        {isActive && (
                          <motion.div
                            key="versions"
                            initial={{ height: 0, opacity: 0 }}
                            animate={{ height: "auto", opacity: 1 }}
                            exit={{ height: 0, opacity: 0 }}
                            transition={spring.moderate}
                            className="overflow-hidden"
                          >
                            <div className="mb-1 ml-[15px] flex min-w-0 max-w-full flex-col gap-0.5 overflow-hidden border-l border-border/70 pl-1.5 pt-0.5">
                              {state.versions.length === 0 && (
                                <span className="px-2 py-1 text-[11.5px] text-muted-foreground/70">
                                  no versions yet
                                </span>
                              )}
                              {[...state.versions].reverse().map((v, i) => {
                                const isLatest = v.id === latest?.id;
                                const isCurrent = v.id === currentId;
                                return (
                                  <motion.button
                                    layout
                                    key={v.id}
                                    whileTap={{ scale: 0.985 }}
                                    initial={{ opacity: 0, x: -6 }}
                                    animate={{ opacity: 1, x: 0 }}
                                    transition={{
                                      ...spring.moderate,
                                      delay: Math.min(i * 0.025, 0.15),
                                    }}
                                    onClick={() => selectVersion(v.id, isLatest)}
                                    className={`flex w-full min-w-0 flex-col gap-px overflow-hidden rounded-lg px-2 py-1.5 text-left transition-colors ${
                                      isCurrent
                                        ? "bg-surface-4 shadow-surface-1"
                                        : "hover:bg-surface-3"
                                    }`}
                                  >
                                    <span className="flex w-full items-center gap-1.5">
                                      <span className="text-[12px] font-semibold tabular-nums">
                                        {v.id}
                                      </span>
                                      {isLatest && (
                                        <Tooltip content="latest" side="right">
                                          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                                        </Tooltip>
                                      )}
                                      <span className="ml-auto text-[10px] tabular-nums text-muted-foreground/60">
                                        {timeAgo(v.ts)}
                                      </span>
                                    </span>
                                    <span
                                      className={`block w-full max-w-full truncate text-[11.5px] ${
                                        isCurrent
                                          ? "text-foreground/80"
                                          : "text-muted-foreground"
                                      }`}
                                    >
                                      {v.label}
                                    </span>
                                  </motion.button>
                                );
                              })}
                            </div>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>
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
                srcDoc={html + CANVAS_STYLE + PICKER_SCRIPT + ANNOTATE_SCRIPT}
                onLoad={() => {
                  setCanvasReady(true);
                  iframeRef.current?.contentWindow?.postMessage(
                    { type: "lucius:mode", on: selectMode },
                    "*",
                  );
                  setTimeout(pushComments, 150);
                }}
                className={`h-full w-full border-0 bg-white transition-opacity duration-200 ease-out ${
                  canvasReady ? "opacity-100" : "opacity-0"
                }`}
              />
            ) : projectLoading || state.versions.length > 0 ? null : (
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

        {/* compose popover — anchored at the highlight */}
        <AnimatePresence>
          {compose && (
            <motion.div
              initial={{ opacity: 0, y: 6, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 6, scale: 0.97 }}
              transition={spring.moderate}
              className="fixed z-50 w-72 rounded-xl border border-border bg-surface-4 p-3 shadow-surface-4"
              style={{
                left: Math.min(Math.max(compose.x - 144, 12), window.innerWidth - 300),
                top: Math.min(compose.y + 6, window.innerHeight - 180),
              }}
            >
              <p className="mb-2 line-clamp-2 border-l-2 border-[#C2410C] pl-2 text-[11.5px] italic text-muted-foreground">
                {compose.anchor.text}
              </p>
              <Textarea
                autoFocus
                value={composeText}
                onChange={(e) => setComposeText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    submitCompose();
                  }
                  if (e.key === "Escape") setCompose(null);
                }}
                placeholder="Comment on this…"
                className="min-h-16 resize-none text-[13px]"
              />
              <div className="mt-2 flex justify-end gap-2">
                <Button size="sm" variant="tertiary" onClick={() => setCompose(null)}>
                  Cancel
                </Button>
                <Button size="sm" onClick={submitCompose} disabled={!composeText.trim()}>
                  Comment
                </Button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* thread popover — click on a highlight */}
        <AnimatePresence>
          {thread && (
            <motion.div
              initial={{ opacity: 0, y: 6, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 6, scale: 0.97 }}
              transition={spring.moderate}
              className="fixed z-50 w-72 rounded-xl border border-border bg-surface-4 p-3 shadow-surface-4"
              style={{
                left: Math.min(Math.max(thread.x - 144, 12), window.innerWidth - 300),
                top: Math.min(thread.y + 6, window.innerHeight - 160),
              }}
              onMouseLeave={() => setThread(null)}
            >
              {state.comments
                .filter((c) => c.id === thread.id)
                .map((c) => (
                  <div key={c.id} className="flex flex-col gap-1">
                    <span className="flex items-baseline gap-2">
                      <span className="text-[12px] font-semibold">{c.author}</span>
                      <span className="text-[10px] tabular-nums text-muted-foreground">
                        {timeAgo(c.ts)}
                      </span>
                    </span>
                    <p className="whitespace-pre-wrap text-[13px] leading-5">{c.text}</p>
                  </div>
                ))}
            </motion.div>
          )}
        </AnimatePresence>

        {/* comments panel */}
        <AnimatePresence>
          {commentsOpen && (
            <motion.div
              initial={{ opacity: 0, x: 16 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 16 }}
              transition={spring.moderate}
              className="fixed right-3 top-14 z-40 flex max-h-[70vh] w-80 flex-col overflow-hidden rounded-xl border border-border bg-surface-3 shadow-surface-4"
            >
              <div className="flex items-center justify-between px-3.5 py-2.5">
                <span className="text-[12px] font-medium text-muted-foreground">
                  Comments · {currentId}
                </span>
                <button
                  className="text-muted-foreground hover:text-foreground"
                  aria-label="Close comments"
                  onClick={() => setCommentsOpen(false)}
                >
                  ×
                </button>
              </div>
              <ScrollArea className="min-h-0 flex-1">
                <div className="flex flex-col gap-3 p-3.5 pt-1">
                  {versionComments.length === 0 && (
                    <span className="text-[12px] text-muted-foreground">
                      No comments on this version — highlight any text on the
                      canvas to start one.
                    </span>
                  )}
                  {[...versionComments].reverse().map((c) => {
                    const anchor = parseAnchor(c.anchor);
                    return (
                      <div key={c.id} className="flex flex-col gap-1">
                        <span className="flex items-baseline gap-2">
                          <span className="text-[12px] font-semibold">{c.author}</span>
                          <span className="text-[10px] tabular-nums text-muted-foreground">
                            {timeAgo(c.ts)}
                          </span>
                        </span>
                        {anchor && (
                          <button
                            className="line-clamp-1 border-l-2 border-[#C2410C] pl-2 text-left text-[11px] italic text-muted-foreground hover:text-foreground"
                            onClick={() =>
                              iframeRef.current?.contentWindow?.postMessage(
                                { type: "lucius:goto-text", anchor },
                                "*",
                              )
                            }
                          >
                            {anchor.text}
                          </button>
                        )}
                        <p className="whitespace-pre-wrap text-[12.5px] leading-5">
                          {c.text}
                        </p>
                      </div>
                    );
                  })}
                </div>
              </ScrollArea>
            </motion.div>
          )}
        </AnimatePresence>

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
  // plain cloud outline on the same 16px grid/stroke as CursorIcon
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden>
      <path
        d="M4.8 12.5 h6.6 a2.9 2.9 0 0 0 .5 -5.76 a4 4 0 0 0 -7.85 .55 A2.75 2.75 0 0 0 4.8 12.5 Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CommentIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden>
      <path
        d="M2.5 4.5 a2 2 0 0 1 2-2 h7 a2 2 0 0 1 2 2 v5 a2 2 0 0 1 -2 2 H7 l-3 2.5 v-2.5 h-.5 a2 2 0 0 1 -2-2 Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CursorIcon() {
  // crosshair — "point at an element"; symmetric, survives 12px
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden>
      <g fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
        <circle cx="8" cy="8" r="3.25" />
        <path d="M8 1.5 V3.5 M8 12.5 V14.5 M1.5 8 H3.5 M12.5 8 H14.5" />
      </g>
    </svg>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 10 10"
      aria-hidden
      className={`shrink-0 text-muted-foreground/70 transition-transform duration-150 ${
        open ? "rotate-90" : ""
      }`}
    >
      <path
        d="M3.5 2 L7 5 L3.5 8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
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
