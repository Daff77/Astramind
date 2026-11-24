import { useEffect, useRef } from "react";
import { EditorState } from "@codemirror/state";
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { defaultHighlightStyle, syntaxHighlighting } from "@codemirror/language";

interface CodeMirrorEditorProps {
  noteId: string;
  value: string;
  onChange: (nextValue: string) => void;
  onSaveShortcut: () => void;
  readOnly?: boolean;
}

export function CodeMirrorEditor({
  noteId,
  value,
  onChange,
  onSaveShortcut,
  readOnly = false,
}: CodeMirrorEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const initialValueRef = useRef(value);
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSaveShortcut);
  const suppressingUpdateRef = useRef(false);

  useEffect(() => {
    initialValueRef.current = value;
  }, [value]);

  useEffect(() => {
    onChangeRef.current = onChange;
    onSaveRef.current = onSaveShortcut;
  }, [onChange, onSaveShortcut]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const saveKeymap = keymap.of([
      {
        key: "Mod-s",
        run: () => {
          onSaveRef.current();
          return true;
        },
      },
    ]);

    const state = EditorState.create({
      doc: initialValueRef.current,
      extensions: [
        lineNumbers(),
        highlightActiveLine(),
        drawSelection(),
        history(),
        markdown(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        EditorView.lineWrapping,
        EditorState.readOnly.of(readOnly),
        EditorView.contentAttributes.of({
          "aria-label": "Markdown note editor",
        }),
        saveKeymap,
        keymap.of([...defaultKeymap, ...historyKeymap]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged && !suppressingUpdateRef.current) {
            onChangeRef.current(update.state.doc.toString());
          }
        }),
      ],
    });

    const view = new EditorView({ state, parent: host });
    viewRef.current = view;

    return () => {
      viewRef.current = null;
      view.destroy();
    };
  }, [noteId, readOnly]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current !== value) {
      suppressingUpdateRef.current = true;
      view.dispatch({
        changes: { from: 0, to: current.length, insert: value },
      });
      suppressingUpdateRef.current = false;
    }
  }, [value]);

  return <div ref={hostRef} className="pb-cm-host" data-testid="cm-editor-host" />;
}
