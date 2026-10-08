'use client';

import { useEffect, useRef, useState, type Ref } from 'react';

// Bottom dock (fixed, thumb-reachable): command bar + mic button. Freeform
// text or speech — no repo/stage/issue pre-selection required. The mic is a
// transcript-only browser control (Web Speech API); no server audio path.

interface CommandDockProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  busy?: boolean;
  /** Optional imperative handle to the command input (prefill + focus). */
  inputRef?: Ref<HTMLInputElement>;
}

type SpeechRecognitionLike = {
  lang: string;
  interimResults: boolean;
  onresult: ((ev: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: ((ev: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
};

function getSpeechRecognition(): (new () => SpeechRecognitionLike) | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function CommandDock({ value, onChange, onSubmit, busy = false, inputRef }: CommandDockProps) {
  const [listening, setListening] = useState(false);
  const [micSupported] = useState(() => getSpeechRecognition() !== null);
  const recogRef = useRef<SpeechRecognitionLike | null>(null);
  const baseRef = useRef('');

  useEffect(() => {
    return () => {
      try {
        recogRef.current?.stop();
      } catch {
        /* ignore */
      }
    };
  }, []);

  const toggleMic = () => {
    const Ctor = getSpeechRecognition();
    if (!Ctor) return;
    if (listening) {
      try {
        recogRef.current?.stop();
      } catch {
        /* ignore */
      }
      return;
    }
    const recog = new Ctor();
    recogRef.current = recog;
    recog.lang = navigator.language || 'en-US';
    recog.interimResults = true;
    baseRef.current = value;
    recog.onresult = (ev) => {
      let transcript = '';
      for (let i = 0; i < ev.results.length; i++) {
        transcript += ev.results[i][0]?.transcript ?? '';
      }
      const sep = baseRef.current && !baseRef.current.endsWith(' ') ? ' ' : '';
      onChange(`${baseRef.current}${sep}${transcript}`.slice(0, 2000));
    };
    recog.onerror = () => setListening(false);
    recog.onend = () => setListening(false);
    try {
      recog.start();
      setListening(true);
    } catch {
      setListening(false);
    }
  };

  return (
    <div className="v2-dock" role="toolbar" aria-label="Command bar">
      {micSupported && (
        <button
          type="button"
          className={`v2-mic${listening ? ' v2-mic-live' : ''}`}
          onClick={toggleMic}
          aria-label={listening ? 'Stop voice input' : 'Start voice input'}
          aria-pressed={listening}
        >
          <svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <path d="M8 1a2.5 2.5 0 00-2.5 2.5v3A2.5 2.5 0 008 9a2.5 2.5 0 002.5-2.5v-3A2.5 2.5 0 008 1z" />
            <path d="M4.5 7a.75.75 0 011.5 0 2 2 0 004 0 .75.75 0 011.5 0 3.5 3.5 0 01-3 3.46V13h1.25a.75.75 0 010 1.5h-3.5a.75.75 0 010-1.5H7.5v-2.54A3.5 3.5 0 014.5 7z" />
          </svg>
        </button>
      )}
      <input
        ref={inputRef}
        className="v2-dock-input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            onSubmit();
          }
        }}
        placeholder={listening ? 'Listening…' : 'Tell DevHub what to do…'}
        aria-label="Command input"
        disabled={busy}
      />
      <button type="button" className="v2-dock-send" onClick={onSubmit} disabled={busy || !value.trim()}>
        {busy ? '…' : '➤'}
      </button>
    </div>
  );
}
