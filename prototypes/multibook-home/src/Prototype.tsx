import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  BookOpenText,
  CaretRight,
  CheckCircle,
  Circle,
  DotsThree,
  ListBullets,
  MagnifyingGlass,
  Microphone,
  Pause,
  Play,
  SpeakerHigh,
  Stop,
  UserCircle,
  UsersThree,
  X,
} from "@phosphor-icons/react";
import "@fontsource-variable/noto-sans-sc/wght.css";
import {
  BottomSheet,
  Carousel,
  KeyboardInput,
  MobileScroll,
  useKeyboard,
} from "./mobile";
import { books, practicePreviews, series, type Book } from "./bookData";

type ViewName = "home" | "library" | "practice" | "class" | "profile";
type RecordingState =
  | "idle"
  | "recording"
  | "paused"
  | "recorded"
  | "submitted";

const primaryBook = books.find((book) => book.id === "3") ?? books[0];
const seriesRank = new Map(series.map((item, index) => [item.id, index]));

const bookCountBySeries: Record<string, string> = {
  casa: "1–4 册",
  "our-world": "Starter · Level 1",
  "oxford-discover": "Level 1–5",
  "reading-explorer": "Foundations · Level 1–5",
  cambridge: "A2 · B1 · 学生书 / 练习册",
};

const formatTime = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

export default function Prototype() {
  const [view, setView] = useState<ViewName>("home");
  const [seriesFilter, setSeriesFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [practiceIndex, setPracticeIndex] = useState(0);
  const [directoryOpen, setDirectoryOpen] = useState(false);
  const [leaveConfirmOpen, setLeaveConfirmOpen] = useState(false);
  const [playingTrackId, setPlayingTrackId] = useState<string | null>(null);
  const [recordingState, setRecordingState] = useState<RecordingState>("idle");
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [recordingPlayback, setRecordingPlayback] = useState(false);
  const [toast, setToast] = useState("");
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  const keyboard = useKeyboard();

  const showToast = (message: string) => {
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    setToast(message);
    toastTimerRef.current = window.setTimeout(() => setToast(""), 2200);
  };

  const go = (next: ViewName) => {
    keyboard.hide();
    // 离开训练页时同步停止示范音频，避免音频在其他页面继续播放。
    if (view === "practice" && next !== "practice") {
      audioRef.current?.pause();
      setPlayingTrackId(null);
      setRecordingPlayback(false);
      setRecordingState("idle");
      setRecordingSeconds(0);
    }
    setView(next);
  };

  const requestPracticeExit = () => {
    if (recordingState === "recording" || recordingState === "paused") {
      showToast("请先结束当前录音，再返回书架");
      return;
    }
    if (recordingState === "recorded") {
      keyboard.hide();
      setLeaveConfirmOpen(true);
      return;
    }
    go("home");
  };

  const openLibrary = (nextSeries = "all") => {
    setSeriesFilter(nextSeries);
    setSearch("");
    go("library");
  };

  const openPractice = () => {
    setPracticeIndex(0);
    setRecordingState("idle");
    setRecordingSeconds(0);
    setRecordingPlayback(false);
    go("practice");
  };

  // 原型中的计时用于验证录音条交互，不调用浏览器麦克风。
  useEffect(() => {
    if (recordingState !== "recording") return;
    const timer = window.setInterval(() => {
      setRecordingSeconds((value) => {
        const next = Math.min(value + 1, 300);
        if (next === 300) setRecordingState("recorded");
        return next;
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [recordingState]);

  useEffect(() => {
    document.title = "海沙牛娃｜多书首页原型";
    return () => {
      audioRef.current?.pause();
      if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    };
  }, []);

  const openBook = (book: Book) => {
    if (book.available) {
      openPractice();
      return;
    }
    keyboard.hide();
    showToast("这本教材正在核对页面与音频，暂未开放");
  };

  const playTrack = (trackId: string, src: string) => {
    if (playingTrackId === trackId) {
      audioRef.current?.pause();
      setPlayingTrackId(null);
      return;
    }

    audioRef.current?.pause();
    const audio = new Audio(src);
    audioRef.current = audio;
    audio.onended = () => setPlayingTrackId(null);
    audio.onerror = () => {
      setPlayingTrackId(null);
      showToast("示范音频未能播放");
    };
    setPlayingTrackId(trackId);
    void audio.play().catch(() => {
      setPlayingTrackId(null);
      showToast("示范音频未能播放");
    });
  };

  const switchPractice = (nextIndex: number) => {
    if (nextIndex < 0 || nextIndex >= practicePreviews.length) return false;
    if (recordingState === "recording" || recordingState === "paused") {
      showToast("请先结束当前录音，再切换训练");
      return false;
    }
    if (recordingState === "recorded") {
      showToast("请先完成本次打卡，再切换训练");
      return false;
    }
    audioRef.current?.pause();
    setPlayingTrackId(null);
    setRecordingPlayback(false);
    setPracticeIndex(nextIndex);
    setRecordingState("idle");
    setRecordingSeconds(0);
    return true;
  };

  return (
    <>
      <MobileScroll className={`app-screen app-screen--${view}`}>
        {view === "home" && (
          <HomeScreen
            onContinue={openPractice}
            onOpenLibrary={openLibrary}
            onSearch={() => openLibrary("all")}
          />
        )}
        {view === "library" && (
          <LibraryScreen
            seriesFilter={seriesFilter}
            search={search}
            onSearch={setSearch}
            onFilter={setSeriesFilter}
            onBack={() => go("home")}
            onBook={openBook}
          />
        )}
        {view === "practice" && (
          <PracticeScreen
            practiceIndex={practiceIndex}
            recordingState={recordingState}
            recordingSeconds={recordingSeconds}
            playingTrackId={playingTrackId}
            onBack={requestPracticeExit}
            onDirectory={() => setDirectoryOpen(true)}
            onPlayTrack={playTrack}
            onPrevious={() => switchPractice(practiceIndex - 1)}
            onNext={() => switchPractice(practiceIndex + 1)}
          />
        )}
        {view === "class" && <ClassPreview onReturn={() => go("home")} />}
        {view === "profile" && (
          <ProfilePreview onOpenLibrary={() => openLibrary("all")} />
        )}
      </MobileScroll>

      {view !== "practice" && (
        <BottomNav
          active={
            view === "class" ? "class" : view === "profile" ? "profile" : "home"
          }
          onSelect={go}
        />
      )}

      {view === "practice" && (
        <RecordingDock
          state={recordingState}
          seconds={recordingSeconds}
          onStart={() => {
            setRecordingSeconds(0);
            setRecordingPlayback(false);
            setRecordingState("recording");
          }}
          onPause={() => {
            setRecordingPlayback(false);
            setRecordingState("paused");
          }}
          onResume={() => {
            setRecordingPlayback(false);
            setRecordingState("recording");
          }}
          onStop={() => {
            setRecordingPlayback(false);
            setRecordingState("recorded");
          }}
          onReset={() => {
            setRecordingSeconds(0);
            setRecordingPlayback(false);
            setRecordingState("recording");
          }}
          playback={recordingPlayback}
          onPlayback={() => setRecordingPlayback((value) => !value)}
          onSubmit={() => {
            setRecordingPlayback(false);
            setRecordingState("submitted");
            showToast("已完成本次打卡（交互预览不上传）");
          }}
        />
      )}

      <BottomSheet
        open={directoryOpen}
        onOpenChange={setDirectoryOpen}
        title="训练目录"
        description="只列出有示范音频的训练页"
        snap={0.56}
      >
        <div className="directory-list">
          <div className="directory-group-title">Unit 1 课文</div>
          {practicePreviews.map((practice, index) => (
            <button
              key={practice.id}
              className={`directory-row ${index === practiceIndex ? "is-current" : ""}`}
              onClick={() => {
                if (switchPractice(index)) setDirectoryOpen(false);
              }}
            >
              <span>
                <b>训练 {index + 1}</b>
                <small>
                  教材资源页 {practice.pageNumber} · {practice.tracks.length} 段音频
                </small>
              </span>
              {index === practiceIndex ? (
                <CheckCircle size={22} weight="fill" />
              ) : (
                <CaretRight size={18} />
              )}
            </button>
          ))}
        </div>
      </BottomSheet>

      <BottomSheet
        open={leaveConfirmOpen}
        onOpenChange={setLeaveConfirmOpen}
        title="录音还没完成打卡"
        description="返回书架会放弃这段未提交的录音。"
        snap={0.36}
      >
        <div className="leave-actions">
          <button
            className="dock-secondary"
            onClick={() => setLeaveConfirmOpen(false)}
          >
            继续跟读
          </button>
          <button
            className="discard-button"
            onClick={() => {
              setLeaveConfirmOpen(false);
              go("home");
            }}
          >
            放弃录音并返回
          </button>
        </div>
      </BottomSheet>

      {toast && (
        <div className="prototype-toast" role="status">
          {toast}
        </div>
      )}
    </>
  );
}

function MiniProgramHeader({
  back,
  search,
}: {
  back?: () => void;
  search?: () => void;
}) {
  return (
    <header className="mini-header">
      <div className="brand-area">
        {back ? (
          <button className="icon-button" aria-label="返回" onClick={back}>
            <ArrowLeft size={24} />
          </button>
        ) : (
          <img className="brand-mark" src="/assets/haisha-mark.png" alt="" />
        )}
        <span>海沙牛娃</span>
      </div>
      <div className="mini-header-actions">
        {search && (
          <button
            className="icon-button"
            aria-label="搜索教材"
            onClick={search}
          >
            <MagnifyingGlass size={23} />
          </button>
        )}
        <div className="wechat-capsule" aria-hidden="true">
          <DotsThree size={24} weight="bold" />
          <i />
          <Circle size={19} weight="bold" />
        </div>
      </div>
    </header>
  );
}

function HomeScreen({
  onContinue,
  onOpenLibrary,
  onSearch,
}: {
  onContinue: () => void;
  onOpenLibrary: (seriesId?: string) => void;
  onSearch: () => void;
}) {
  return (
    <main className="home-content">
      <MiniProgramHeader search={onSearch} />
      <section className="home-heading">
        <h1>接着上次，读一页</h1>
      </section>

      <section className="continue-card">
        <img src={primaryBook.cover} alt={`${primaryBook.title}封面`} />
        <div className="continue-card__body">
          <h2>{primaryBook.title}</h2>
          <p>上次练到 Unit 1 · 课文</p>
          <span className="available-label">
            <CheckCircle size={16} weight="fill" />
            可跟读
          </span>
          <button className="primary-button" onClick={onContinue}>
            继续跟读
          </button>
        </div>
      </section>

      <section className="series-section">
        <div className="section-heading">
          <div>
            <h2>按系列找书</h2>
            <p>5 个系列 · 23 册</p>
          </div>
          <button
            className="text-button"
            onClick={() => onOpenLibrary("all")}
          >
            全部教材 <CaretRight size={17} />
          </button>
        </div>
        <div className="series-list">
          {series.map((item) => (
            <button
              key={item.id}
              className="series-row"
              onClick={() => onOpenLibrary(item.id)}
            >
              <img src={item.cover} alt="" />
              <span className="series-row__text">
                <b>{item.title}</b>
                <small>{bookCountBySeries[item.id]}</small>
              </span>
              <span
                className={
                  item.availableCount
                    ? "series-status is-active"
                    : "series-status"
                }
              >
                {item.availableCount
                  ? `${item.availableCount} 册可练`
                  : "待上线"}
              </span>
              <CaretRight className="row-caret" size={18} />
            </button>
          ))}
        </div>
      </section>
    </main>
  );
}

function LibraryScreen({
  seriesFilter,
  search,
  onSearch,
  onFilter,
  onBack,
  onBook,
}: {
  seriesFilter: string;
  search: string;
  onSearch: (value: string) => void;
  onFilter: (value: string) => void;
  onBack: () => void;
  onBook: (book: Book) => void;
}) {
  const normalizedSearch = search.trim().toLowerCase();
  const visibleBooks = useMemo(
    () =>
      books.filter(
        (book) =>
          (seriesFilter === "all" || book.seriesId === seriesFilter) &&
          (!normalizedSearch ||
            `${book.title} ${book.level} ${book.kind}`
              .toLowerCase()
              .includes(normalizedSearch)),
      ).sort(
        (a, b) =>
          (seriesRank.get(a.seriesId) ?? 99) -
          (seriesRank.get(b.seriesId) ?? 99),
      ),
    [normalizedSearch, seriesFilter],
  );
  const title =
    seriesFilter === "all"
      ? "全部教材"
      : series.find((item) => item.id === seriesFilter)?.title;

  return (
    <main className="library-content">
      <MiniProgramHeader back={onBack} />
      <div className="page-title-row">
        <div>
          <h1>{title}</h1>
          <p>{visibleBooks.length} 册教材</p>
        </div>
      </div>
      <label className="search-field">
        <MagnifyingGlass size={20} />
        <KeyboardInput
          aria-label="搜索教材"
          placeholder="搜索书名、级别或册别"
          value={search}
          onChange={(event) => onSearch(event.target.value)}
        />
        {search && (
          <button aria-label="清空搜索" onClick={() => onSearch("")}>
            <X size={17} />
          </button>
        )}
      </label>
      <Carousel
        className="filter-rail"
        contentClassName="filter-rail__track"
        ariaLabel="教材系列筛选"
      >
        <button
          className={seriesFilter === "all" ? "is-selected" : ""}
          aria-pressed={seriesFilter === "all"}
          onClick={() => onFilter("all")}
        >
          全部
        </button>
        {series.map((item) => (
          <button
            key={item.id}
            className={seriesFilter === item.id ? "is-selected" : ""}
            aria-pressed={seriesFilter === item.id}
            onClick={() => onFilter(item.id)}
          >
            {item.title
              .replace("CASA 阅读与自然拼读", "CASA")
              .replace("剑桥英语", "剑桥")}
          </button>
        ))}
      </Carousel>
      {visibleBooks.length ? (
        <div className="book-list">
          {visibleBooks.map((book) => (
            <button
              key={book.id}
              className="book-row"
              onClick={() => onBook(book)}
            >
              <img src={book.cover} alt={`${book.title}封面`} />
              <span className="book-row__text">
                <b>{book.title}</b>
                <small>
                  {book.level} · {book.kind}
                </small>
              </span>
              <span
                className={book.available ? "book-state is-active" : "book-state"}
              >
                {book.available ? "可跟读" : "待上线"}
              </span>
              <CaretRight size={18} />
            </button>
          ))}
        </div>
      ) : (
        <div className="empty-state">
          <BookOpenText size={38} />
          <b>没有找到这本教材</b>
          <p>换一个书名或级别试试</p>
        </div>
      )}
    </main>
  );
}

function PracticeScreen({
  practiceIndex,
  recordingState,
  recordingSeconds,
  playingTrackId,
  onBack,
  onDirectory,
  onPlayTrack,
  onPrevious,
  onNext,
}: {
  practiceIndex: number;
  recordingState: RecordingState;
  recordingSeconds: number;
  playingTrackId: string | null;
  onBack: () => void;
  onDirectory: () => void;
  onPlayTrack: (id: string, src: string) => void;
  onPrevious: () => void;
  onNext: () => void;
}) {
  const practice = practicePreviews[practiceIndex];
  return (
    <main className="practice-content">
      <header className="practice-toolbar">
        <button className="icon-button" aria-label="返回书架" onClick={onBack}>
          <ArrowLeft size={24} />
        </button>
        <div>
          <b>{primaryBook.title}</b>
          <span>{practice.section}</span>
        </div>
        <button className="directory-button" onClick={onDirectory}>
          <ListBullets size={19} />
          目录
        </button>
      </header>
      <section className="practice-meta">
        <p>
          跟读训练 {practiceIndex + 1} / {practicePreviews.length}
        </p>
        <span>点击图片上的播放标记，边听边跟读</span>
      </section>
      <section className="book-page-wrap">
        <img src={practice.image} alt={`教材资源页 ${practice.pageNumber}`} />
        {practice.tracks.map((track, index) => (
          <button
            key={track.id}
            className={`audio-hotspot ${playingTrackId === track.id ? "is-playing" : ""}`}
            style={{ left: `${track.left}%`, top: `${track.top}%` }}
            aria-label={`${playingTrackId === track.id ? "停止" : "播放"}${track.label}`}
            onClick={() => onPlayTrack(track.id, track.src)}
          >
            {playingTrackId === track.id ? (
              <Stop size={14} weight="fill" />
            ) : (
              <Play size={14} weight="fill" />
            )}
            <span>{index + 1}</span>
          </button>
        ))}
      </section>
      <div className="page-source-label">
        教材资源页 {practice.pageNumber} · {practice.tracks.length} 段示范音频
      </div>
      <nav className="practice-pager">
        <button disabled={practiceIndex === 0} onClick={onPrevious}>
          上一个训练
        </button>
        <button
          disabled={practiceIndex === practicePreviews.length - 1}
          onClick={onNext}
        >
          下一个训练
        </button>
      </nav>
      <div
        className="practice-bottom-spacer"
        data-recording-state={recordingState}
        data-elapsed={recordingSeconds}
      />
    </main>
  );
}

function RecordingDock({
  state,
  seconds,
  playback,
  onStart,
  onPause,
  onResume,
  onStop,
  onReset,
  onPlayback,
  onSubmit,
}: {
  state: RecordingState;
  seconds: number;
  playback: boolean;
  onStart: () => void;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
  onReset: () => void;
  onPlayback: () => void;
  onSubmit: () => void;
}) {
  return (
    <aside className="recording-dock" aria-label="跟读录音控制">
      <div className="recording-dock__status">
        <span
          className={
            state === "recording"
              ? "record-dot is-live"
              : state === "submitted"
                ? "record-dot is-done"
                : "record-dot"
          }
        />
        <div>
          <b>
            {state === "idle"
              ? "我的跟读"
              : state === "recording"
                ? "正在录音"
                : state === "paused"
                  ? "录音已暂停"
                  : state === "recorded"
                    ? playback
                      ? "正在回听"
                      : "录音完成"
                    : "已完成打卡"}
          </b>
          <small>{state === "idle" ? "最长 5:00" : formatTime(seconds)}</small>
        </div>
      </div>
      <div className="recording-dock__actions">
        {state === "idle" && (
          <button className="dock-primary" onClick={onStart}>
            <Microphone size={21} weight="fill" />
            开始录音
          </button>
        )}
        {state === "recording" && (
          <>
            <button className="dock-secondary" onClick={onPause}>
              <Pause size={20} weight="fill" />
              暂停
            </button>
            <button className="dock-primary" onClick={onStop}>
              <Stop size={19} weight="fill" />
              结束
            </button>
          </>
        )}
        {state === "paused" && (
          <>
            <button className="dock-secondary" onClick={onResume}>
              <Microphone size={20} />
              继续
            </button>
            <button className="dock-primary" onClick={onStop}>
              <Stop size={19} weight="fill" />
              结束
            </button>
          </>
        )}
        {state === "recorded" && (
          <>
            <button className="dock-secondary dock-playback" onClick={onPlayback}>
              {playback ? (
                <Pause size={18} weight="fill" />
              ) : (
                <SpeakerHigh size={18} weight="fill" />
              )}
              {playback ? "暂停" : "回听"}
            </button>
            <button className="dock-secondary dock-reset" onClick={onReset}>
              重录
            </button>
            <button className="dock-primary" onClick={onSubmit}>
              <CheckCircle size={20} weight="fill" />
              完成打卡
            </button>
          </>
        )}
        {state === "submitted" && (
          <button className="dock-secondary" onClick={onReset}>
            再次录音
          </button>
        )}
      </div>
    </aside>
  );
}

function BottomNav({
  active,
  onSelect,
}: {
  active: "home" | "class" | "profile";
  onSelect: (target: ViewName) => void;
}) {
  return (
    <nav className="bottom-nav" aria-label="主要导航">
      <button
        className={active === "home" ? "is-active" : ""}
        aria-current={active === "home" ? "page" : undefined}
        onClick={() => onSelect("home")}
      >
        <BookOpenText
          size={25}
          weight={active === "home" ? "fill" : "regular"}
        />
        <span>学习</span>
      </button>
      <button
        className={active === "class" ? "is-active" : ""}
        aria-current={active === "class" ? "page" : undefined}
        onClick={() => onSelect("class")}
      >
        <UsersThree
          size={26}
          weight={active === "class" ? "fill" : "regular"}
        />
        <span>班级</span>
      </button>
      <button
        className={active === "profile" ? "is-active" : ""}
        aria-current={active === "profile" ? "page" : undefined}
        onClick={() => onSelect("profile")}
      >
        <UserCircle
          size={26}
          weight={active === "profile" ? "fill" : "regular"}
        />
        <span>我的</span>
      </button>
    </nav>
  );
}

function ClassPreview({ onReturn }: { onReturn: () => void }) {
  return (
    <main className="simple-content">
      <MiniProgramHeader />
      <span className="eyebrow">规划中的页面</span>
      <h1>班级</h1>
      <div className="simple-panel">
        <UsersThree size={42} />
        <h2>老师创建班级，学生扫码加入</h2>
        <p>
          正式接入后，老师可以按学生检查跟读录音；班级码不会授予老师权限。
        </p>
        <button className="primary-button" onClick={onReturn}>
          返回学习
        </button>
      </div>
    </main>
  );
}

function ProfilePreview({
  onOpenLibrary,
}: {
  onOpenLibrary: () => void;
}) {
  return (
    <main className="simple-content">
      <MiniProgramHeader />
      <span className="eyebrow">个人学习记录</span>
      <h1>我的</h1>
      <div className="simple-panel">
        <SpeakerHigh size={42} />
        <h2>我的跟读打卡</h2>
        <p>录音按微信身份保存在云端。后续可按教材筛选、回听或删除。</p>
        <button className="primary-button" onClick={onOpenLibrary}>
          查看全部教材
        </button>
      </div>
    </main>
  );
}
