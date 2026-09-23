import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeSanitize from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';

type MarkdownPreviewProps = {
  value: string;
  className?: string;
  emptyMessage?: string;
};

export function MarkdownPreview({ value, className = '', emptyMessage }: MarkdownPreviewProps) {
  if (!value.trim()) {
    return emptyMessage ? <p className={`markdown-preview ${className}`}>{emptyMessage}</p> : null;
  }
  return <div className={`markdown-preview ${className}`.trim()}>
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeSanitize]}
      components={{
        a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer noopener" />,
      }}
    >
      {value}
    </ReactMarkdown>
  </div>;
}

type MarkdownEditorProps = {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  maxLength?: number;
  rows?: number;
  required?: boolean;
  disabled?: boolean;
  autoFocus?: boolean;
  hint?: string;
};

export function focusMarkdownEditor(id: string) {
  document.getElementById(id)?.dispatchEvent(new Event('markdown-focus'));
}

export function MarkdownEditor({
  id,
  label,
  value,
  onChange,
  placeholder,
  maxLength,
  rows = 6,
  required = false,
  disabled = false,
  autoFocus = false,
  hint,
}: MarkdownEditorProps) {
  const areaRef = useRef<HTMLTextAreaElement | null>(null);
  const [tab, setTab] = useState<'write' | 'preview'>('write');
  const [limitMessage, setLimitMessage] = useState('');
  useEffect(() => {
    const area = areaRef.current;
    const focus = () => { setTab('write'); requestAnimationFrame(() => area?.focus()); };
    area?.addEventListener('markdown-focus', focus);
    return () => area?.removeEventListener('markdown-focus', focus);
  }, []);
  useEffect(() => { if (!value) setTab('write'); }, [value]);

  function applyEdit(nextValue: string, selectionStart: number, selectionEnd: number) {
    if (maxLength !== undefined && nextValue.length > maxLength) {
      setLimitMessage(`This formatting would exceed the ${maxLength.toLocaleString()} character limit.`);
      return;
    }
    setLimitMessage(''); setTab('write');
    onChange(nextValue);
    requestAnimationFrame(() => {
      if (!areaRef.current) return;
      areaRef.current.focus();
      areaRef.current.setSelectionRange(selectionStart, selectionEnd);
    });
  }

  function wrapSelection(prefix: string, suffix: string, fallback: string) {
    const element = areaRef.current;
    if (!element || disabled) return;
    const start = element.selectionStart;
    const end = element.selectionEnd;
    const selected = value.slice(start, end);
    const insert = `${prefix}${selected || fallback}${suffix}`;
    const next = `${value.slice(0, start)}${insert}${value.slice(end)}`;
    const cursor = selected ? start + insert.length : start + prefix.length + fallback.length;
    applyEdit(next, cursor, cursor);
  }

  function insertText(text: string) {
    const element = areaRef.current;
    if (!element || disabled) return;
    const start = element.selectionStart;
    const end = element.selectionEnd;
    const next = `${value.slice(0, start)}${text}${value.slice(end)}`;
    const cursor = start + text.length;
    applyEdit(next, cursor, cursor);
  }

  function insertLink() {
    const element = areaRef.current;
    if (!element || disabled) return;
    const start = element.selectionStart;
    const end = element.selectionEnd;
    const selected = value.slice(start, end);
    const link = /^https?:\/\//i.test(selected.trim())
      ? `[link text](${selected.trim()})`
      : `[${selected || 'link text'}](https://example.com)`;
    const next = `${value.slice(0, start)}${link}${value.slice(end)}`;
    const cursor = start + link.length;
    applyEdit(next, cursor, cursor);
  }

  return <div className="markdown-editor">
    <div className="field-label"><label htmlFor={id}>{label}</label></div>
    <div className="markdown-editor-header" role="group" aria-label="Markdown tools">
      <div className="markdown-toolbar">
        <button type="button" className="text-button" disabled={disabled} onClick={() => wrapSelection('**', '**', 'bold text')}>Bold</button>
        <button type="button" className="text-button" disabled={disabled} onClick={() => wrapSelection('*', '*', 'italic text')}>Italic</button>
        <button type="button" className="text-button" disabled={disabled} onClick={() => wrapSelection('`', '`', 'code')}>Code</button>
        <button type="button" className="text-button" disabled={disabled} onClick={() => wrapSelection('```\n', '\n```', 'code block')}>Code block</button>
        <button type="button" className="text-button" disabled={disabled} onClick={insertLink}>Link</button>
        <button type="button" className="text-button" disabled={disabled} onClick={() => insertText('🙂')}>Emoji</button>
      </div>
      <div className="markdown-tabs" role="tablist" aria-label="Write or preview" onKeyDown={event => {
        if (disabled || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const next = event.key === 'Home' ? 'write' : event.key === 'End' ? 'preview' : tab === 'write' ? 'preview' : 'write';
        setTab(next); requestAnimationFrame(() => document.getElementById(`${id}-${next}-tab`)?.focus());
      }}>
        <button id={`${id}-write-tab`} type="button" role="tab" aria-controls={`${id}-write-panel`} aria-selected={tab === 'write'} tabIndex={tab === 'write' ? 0 : -1} disabled={disabled} className="text-button" onClick={() => setTab('write')}>Write</button>
        <button id={`${id}-preview-tab`} type="button" role="tab" aria-controls={`${id}-preview-panel`} aria-selected={tab === 'preview'} tabIndex={tab === 'preview' ? 0 : -1} disabled={disabled} className="text-button" onClick={() => setTab('preview')}>Preview</button>
      </div>
    </div>
    <div id={`${id}-write-panel`} role="tabpanel" aria-labelledby={`${id}-write-tab`} hidden={tab !== 'write'}><textarea
      id={id}
      ref={areaRef}
      value={value}
      onChange={event => { setLimitMessage(''); onChange(event.target.value); }}
      placeholder={placeholder}
      maxLength={maxLength}
      rows={rows}
      required={required}
      disabled={disabled}
      autoFocus={autoFocus}
    /></div>
    <div id={`${id}-preview-panel`} className="markdown-preview-panel" role="tabpanel" aria-labelledby={`${id}-preview-tab`} hidden={tab !== 'preview'}>
      {tab === 'preview' && <MarkdownPreview value={value} emptyMessage="Nothing to preview yet. Start writing in the Write tab." />}
    </div>
    {limitMessage && <p className="field-hint" role="alert">{limitMessage}</p>}
    {hint && <p className="field-hint">{hint}</p>}
  </div>;
}
