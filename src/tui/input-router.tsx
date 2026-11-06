import { useInput, usePaste, useStdin, useStdout, type Key } from "ink";
import { createContext, useContext, useEffect, useLayoutEffect, useRef, type ReactNode } from "react";

export type UiKey = Key & { wheel?: number };
type Handler = (input: string, key: UiKey) => boolean | void;
interface Entry { priority: number; handler: Handler }
const InputContext = createContext<Set<Entry> | null>(null);

export function TerminalInput({ children }: { children: ReactNode }) {
  const entries = useRef(new Set<Entry>()).current;
  const { stdin } = useStdin();
  const { stdout } = useStdout();
  usePaste(() => {}); // Swallow paste packets even when only a selector/modal is visible.
  function dispatch(input: string, key: UiKey): void {
    for (const entry of [...entries].sort((a, b) => b.priority - a.priority)) {
      if (entry.handler(input, key)) break;
    }
  }
  useInput((input, key) => {
    // Ink's parser assembles fragmented CSI packets before delivering input.
    const mouse = /\[<(\d+);\d+;\d+([mM])$/.exec(input);
    if (mouse) {
      if (mouse[2] === "M" && (mouse[1] === "64" || mouse[1] === "65")) dispatch("", { wheel: mouse[1] === "64" ? -3 : 3 } as UiKey);
      return;
    }
    if (key.eventType === "release") return;
    dispatch(input, key);
  });
  useEffect(() => {
    if (!stdout.isTTY || !stdin.isTTY) return;
    stdout.write("\x1b[?1000h\x1b[?1006h");
    return () => {
      stdout.write("\x1b[?1000l\x1b[?1006l");
    };
  }, [stdin, stdout]);
  return <InputContext.Provider value={entries}>{children}</InputContext.Provider>;
}

/** One consuming dispatcher in the app; standalone components remain testable. */
export function useRoutedInput(priority: number, handler: Handler, active = true): void {
  const entries = useContext(InputContext);
  const current = useRef(handler);
  current.current = handler;
  useLayoutEffect(() => {
    if (!entries || !active) return;
    const entry: Entry = { priority, handler: (input, key) => current.current(input, key) };
    entries.add(entry);
    return () => { entries.delete(entry); };
  }, [entries, priority, active]);
  useInput((input, key) => { current.current(input, key); }, { isActive: !entries && active });
}
