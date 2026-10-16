import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import PropTypes from 'prop-types';
import { ArrowLeft, Network, MoreHorizontal, Globe, FolderLock, Download, Settings, X } from 'lucide-react';

export const iconButton = 'inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-slate-600 hover:bg-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-700';
export default function ConversationNavigation({ panel, onPanelChange }) {
  const [open, setOpen] = useState(false), root = useRef(null), trigger = useRef(null), first = useRef(null);
  function close() { setOpen(false); trigger.current?.focus(); }
  useEffect(() => {
    if (!open) return;
    first.current?.focus();
    const outside = event => { if (!root.current?.contains(event.target)) setOpen(false); };
    const escape = event => { if (event.key === 'Escape') { event.preventDefault(); setOpen(false); trigger.current?.focus(); } };
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [open]);
  function show(name) { close(); onPanelChange(name); }
  const item = 'flex min-h-11 w-full items-center gap-3 rounded-lg px-3 text-left text-sm hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-slate-700';
  return <header className="flex items-center justify-between px-3 py-2 pr-[4.5rem] sm:px-4 sm:pr-[4.5rem]">
    <h1 className="sr-only">New conversation</h1>
    <Link to="/" aria-label="Back to home" title="Back" className={iconButton}><ArrowLeft size={21} aria-hidden="true" /></Link>
    <nav aria-label="Conversation navigation" className="flex items-center gap-1">
      <button type="button" className={iconButton} aria-label="AI map" title="AI map" aria-expanded={panel === 'map'} onClick={() => onPanelChange(panel === 'map' ? null : 'map')}><Network size={21} aria-hidden="true" /></button>
      <div ref={root} className="relative" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
        <button ref={trigger} type="button" className={iconButton} aria-label="More options" title="More options" aria-expanded={open} aria-controls="conversation-more" onClick={() => setOpen(v => !v)}><MoreHorizontal size={22} aria-hidden="true" /></button>
        {open && <div id="conversation-more" aria-label="More options" className="absolute right-0 top-full z-[60] mt-1 w-60 rounded-xl border border-slate-200 bg-white p-2 shadow-lg">
          <Link ref={first} className={item} to="/public" onClick={close}><Globe size={18} aria-hidden="true" />Public conversations</Link>
          <Link className={item} to="/private-files" onClick={close}><FolderLock size={18} aria-hidden="true" />Private files</Link>
          <button className={item} onClick={() => show('files')}><Download size={18} aria-hidden="true" />Files &amp; export</button>
          <button className={item} onClick={() => show('settings')}><Settings size={18} aria-hidden="true" />Settings</button>
        </div>}
      </div>
    </nav>
  </header>;
}
ConversationNavigation.propTypes = { panel: PropTypes.string, onPanelChange: PropTypes.func.isRequired };
export function CloseConversationTools({ onClose }) { return <button type="button" aria-label="Close tools" title="Close" className={`${iconButton} sticky top-0 float-right bg-white`} onClick={onClose}><X size={18} aria-hidden="true" /></button>; }
CloseConversationTools.propTypes = { onClose: PropTypes.func.isRequired };
