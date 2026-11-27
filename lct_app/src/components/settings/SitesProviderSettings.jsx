import { useRef, useState } from 'react';
import PropTypes from 'prop-types';
import { ArrowDown, ArrowUp, GripVertical, Trash2 } from 'lucide-react';
import { useSitesRuntime } from '../../contexts/SitesRuntimeContext';
import ProviderKeyForm from './ProviderKeyForm';
import { MAP_PROVIDERS } from '../../services/cloud/openRouterClient';
import { ANTHROPIC_PRICING_URL, anthropicModelPriceLabel } from '../../services/cloud/anthropicModelPrices';
import { MAP_PROVIDER_IDS, MAX_MAP_ROUTES, SPEECH_PROVIDERS, validModelId } from '../../services/cloud/sitesProviderPreferences';
import { DEFAULT_M5_TAILNET_URL, isAllowedTailnetUrl, probeM5TailnetEndpoint } from '../../services/cloud/m5TailnetFileSession';

const speechGroup = {
  title: 'Speech-to-text',
  intro: 'Drag to set priority for live recording and audio files. Enabled providers run in order from top to bottom.',
  providers: SPEECH_PROVIDERS,
};
const input = 'min-h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900 focus:border-slate-500 focus:outline-none';
const button = 'min-h-10 rounded-lg border border-slate-300 bg-white px-3 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-35';
const iconBtn = 'inline-flex h-8 w-8 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 hover:text-slate-900 disabled:opacity-30';
const CUSTOM_MODEL = '__custom__';

function reorderList(list, fromIndex, toIndex) {
  if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0 || fromIndex >= list.length || toIndex >= list.length) {
    return list;
  }
  const next = [...list];
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved);
  return next;
}

function rankBadgeClass(index) {
  return index === 0
    ? 'inline-flex items-center rounded-full bg-slate-900 px-2.5 py-0.5 text-[11px] font-medium text-white'
    : 'inline-flex items-center rounded-full bg-slate-100 px-2.5 py-0.5 text-[11px] font-medium text-slate-600';
}

function modelsForProvider(backend, catalogs) {
  return catalogs[backend] || [];
}

function modelOptionLabel(backend, { id, label }) {
  const price = backend === 'anthropic' ? anthropicModelPriceLabel(id) : '';
  if (price) return `${label} · ${price}`;
  return label === id ? id : `${label} (${id})`;
}

function SpeechOrder() {
  const { preferences, save, keys } = useSitesRuntime();
  const [m5Draft, setM5Draft] = useState(null);
  const [m5Probe, setM5Probe] = useState({ testing: false, result: null });
  const [dragIndex, setDragIndex] = useState(null);
  const dragIndexRef = useRef(null);
  const [overIndex, setOverIndex] = useState(null);
  const order = preferences.speech;
  const ids = [...order, ...Object.keys(speechGroup.providers).filter(id => !order.includes(id))];
  const m5Url = m5Draft ?? (preferences.m5TailnetUrl || DEFAULT_M5_TAILNET_URL);

  function move(id, direction) {
    const index = order.indexOf(id);
    save({ speech: reorderList(order, index, index + direction) });
  }

  function handleDrop(targetIndex, event) {
    const raw = dragIndexRef.current ?? dragIndex ?? Number(event?.dataTransfer?.getData('text/plain'));
    const from = Number.isInteger(raw) ? raw : null;
    if (from != null && targetIndex >= 0 && from !== targetIndex) {
      save({ speech: reorderList(order, from, targetIndex) });
    }
    dragIndexRef.current = null;
    setDragIndex(null);
    setOverIndex(null);
  }

  async function handleTestM5() {
    const trimmed = m5Url.trim();
    if (!trimmed || isAllowedTailnetUrl(trimmed)) save({ m5TailnetUrl: trimmed });
    setM5Probe({ testing: true, result: null });
    const result = await probeM5TailnetEndpoint(trimmed, { token: keys.m5_tailnet || '' });
    setM5Probe({ testing: false, result });
  }

  return <section id="speech-to-text" className="scroll-mt-5 space-y-3">
    <header>
      <h3 className="text-lg font-semibold text-slate-900">{speechGroup.title}</h3>
      <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-600">{speechGroup.intro}</p>
    </header>
    <ol className="space-y-2.5">
      {ids.map(id => {
        const index = order.indexOf(id);
        const enabled = index >= 0;
        const { name, detail } = speechGroup.providers[id];
        const isDragging = enabled && dragIndex === index;
        const isOver = enabled && overIndex === index && dragIndex !== null && dragIndex !== index;
        return <li
          key={id}
          draggable={enabled && order.length > 1}
          onDragStart={event => {
            if (!enabled) return;
            dragIndexRef.current = index;
            setDragIndex(index);
            event.dataTransfer?.setData('text/plain', String(index));
            if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
          }}
          onDragOver={event => {
            if (!enabled || (dragIndexRef.current === null && dragIndex === null)) return;
            event.preventDefault();
            if (overIndex !== index) setOverIndex(index);
          }}
          onDragLeave={() => { if (overIndex === index) setOverIndex(null); }}
          onDrop={event => {
            if (!enabled) return;
            event.preventDefault();
            handleDrop(index, event);
          }}
          onDragEnd={() => { dragIndexRef.current = null; setDragIndex(null); setOverIndex(null); }}
          className={`space-y-2.5 rounded-xl border p-4 transition ${
            enabled
              ? 'border-slate-200 bg-white shadow-xs'
              : 'border-dashed border-slate-200 bg-slate-50/70'
          } ${isDragging ? 'opacity-50' : ''} ${isOver ? 'ring-2 ring-slate-900/25 border-slate-400' : ''}`}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2.5">
              {enabled ? (
                <span
                  aria-hidden="true"
                  title={order.length > 1 ? 'Drag to reorder' : undefined}
                  className={`inline-flex h-8 w-6 items-center justify-center text-slate-400 ${order.length > 1 ? 'cursor-grab active:cursor-grabbing hover:text-slate-700' : 'opacity-30'}`}
                >
                  <GripVertical size={16} />
                </span>
              ) : (
                <span className="inline-block w-6" aria-hidden="true" />
              )}
              <label className="flex min-h-10 cursor-pointer items-center gap-3">
                <input type="checkbox" checked={enabled} disabled={index === 0 && order.length === 1}
                  onChange={event => save({ speech: event.target.checked ? [...order, id] : order.filter(provider => provider !== id) })} />
                <span>
                  <span className="flex flex-wrap items-center gap-2 font-medium text-slate-900">
                    {name}
                    {enabled && <span className={rankBadgeClass(index)}>{index === 0 ? 'First choice' : `Fallback ${index}`}</span>}
                  </span>
                  <span className="block text-xs text-slate-500">{detail ?? (keys[id] ? 'Personal account' : 'Site configuration')}</span>
                </span>
              </label>
            </div>
            {enabled && <div className="flex items-center gap-1">
              <button type="button" className={iconBtn} disabled={!index} onClick={() => move(id, -1)} aria-label={`Move ${name} up`} title={`Move ${name} up`}><ArrowUp size={14} /></button>
              <button type="button" className={iconBtn} disabled={index >= order.length - 1} onClick={() => move(id, 1)} aria-label={`Move ${name} down`} title={`Move ${name} down`}><ArrowDown size={14} /></button>
            </div>}
          </div>
          {id === 'm5_tailnet' && enabled && (
            <div className="space-y-1.5 pl-8">
              <label className="grid gap-1 text-xs text-slate-600">
                Tailnet endpoint (HTTPS *.ts.net)
                <div className="flex flex-wrap gap-2">
                  <input
                    className={`${input} flex-1 min-w-[16rem]`}
                    value={m5Url}
                    placeholder={DEFAULT_M5_TAILNET_URL}
                    onChange={event => {
                      setM5Draft(event.target.value);
                      if (m5Probe.result) setM5Probe({ testing: false, result: null });
                    }}
                    onBlur={event => {
                      const val = event.target.value.trim();
                      if (!val || isAllowedTailnetUrl(val)) save({ m5TailnetUrl: val });
                    }}
                  />
                  <button
                    type="button"
                    className={button}
                    disabled={m5Probe.testing}
                    onClick={handleTestM5}
                  >
                    {m5Probe.testing ? 'Testing…' : 'Test endpoint'}
                  </button>
                </div>
              </label>
              {m5Probe.result && (
                <p
                  role="status"
                  className={`text-xs ${m5Probe.result.ok ? 'text-emerald-700' : 'text-rose-700'}`}
                >
                  {m5Probe.result.message}
                </p>
              )}
            </div>
          )}
          <div className="pl-8">
            <ProviderKeyForm backend={id} name={name} speech />
          </div>
        </li>;
      })}
    </ol>
  </section>;
}

function FallbackRow({
  entry, index, total, onUpdate, onMove, onRemove,
  isDragging, isOver, onDragStart, onDragOver, onDragLeave, onDrop, onDragEnd,
}) {
  const { keys, catalogs } = useSitesRuntime();
  const [customMode, setCustomMode] = useState(false);
  const [customDraft, setCustomDraft] = useState('');
  const options = modelsForProvider(entry.backend, catalogs);
  const hasKey = Boolean(keys[entry.backend]);
  const inList = !entry.model || options.some(item => item.id === entry.model);
  const rankLabel = index === 0 ? 'First choice' : `Fallback ${index}`;

  function handleProviderChange(nextBackend) {
    const nextModels = modelsForProvider(nextBackend, catalogs);
    const nextModel = keys[nextBackend] ? (nextModels[0]?.id || '') : '';
    setCustomMode(false);
    onUpdate(index, { backend: nextBackend, model: nextModel });
  }

  function handleModelSelect(value) {
    if (value === CUSTOM_MODEL) {
      setCustomDraft(entry.model || '');
      setCustomMode(true);
      return;
    }
    setCustomMode(false);
    onUpdate(index, { ...entry, model: value });
  }

  function commitCustom() {
    const trimmed = customDraft.trim();
    if (validModelId(trimmed)) onUpdate(index, { ...entry, model: trimmed });
    setCustomMode(false);
  }

  return <li
    draggable={total > 1}
    onDragStart={onDragStart}
    onDragOver={onDragOver}
    onDragLeave={onDragLeave}
    onDrop={onDrop}
    onDragEnd={onDragEnd}
    className={`space-y-3 rounded-xl border border-slate-200 bg-white p-4 shadow-xs transition ${
      isDragging ? 'opacity-50' : ''
    } ${isOver ? 'ring-2 ring-slate-900/25 border-slate-400' : ''}`}
  >
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex items-center gap-2">
        <span
          aria-hidden="true"
          title={total > 1 ? 'Drag to reorder' : undefined}
          className={`inline-flex h-8 w-6 items-center justify-center text-slate-400 ${total > 1 ? 'cursor-grab active:cursor-grabbing hover:text-slate-700' : 'opacity-30'}`}
        >
          <GripVertical size={16} />
        </span>
        <span className={rankBadgeClass(index)}>{rankLabel}</span>
      </div>
      <div className="flex flex-wrap items-center gap-1">
        <button type="button" className={iconBtn} disabled={index === 0} onClick={() => onMove(index, -1)} aria-label={`Move ${rankLabel} up`} title={`Move ${rankLabel} up`}><ArrowUp size={14} /></button>
        <button type="button" className={iconBtn} disabled={index >= total - 1} onClick={() => onMove(index, 1)} aria-label={`Move ${rankLabel} down`} title={`Move ${rankLabel} down`}><ArrowDown size={14} /></button>
        <button type="button" className={`${iconBtn} hover:text-rose-700`} disabled={total <= 1} onClick={() => onRemove(index)} aria-label={`Remove ${rankLabel}`} title={`Remove ${rankLabel}`}><Trash2 size={14} /></button>
      </div>
    </div>
    <div className="grid gap-3 pl-8 sm:grid-cols-2">
      <label className="grid gap-1 text-xs font-medium text-slate-600">Provider
        <select className={input} aria-label={`${rankLabel} provider`} value={entry.backend} onChange={event => handleProviderChange(event.target.value)}>
          {MAP_PROVIDER_IDS.map(id => <option key={id} value={id}>
            {MAP_PROVIDERS[id].name}{keys[id] ? ' (Personal key)' : ' (Site)'}
          </option>)}
        </select>
      </label>
      {customMode ? <div className="grid gap-1 text-xs font-medium text-slate-600">
        <label htmlFor={`custom-model-${index}`}>Custom model ID</label>
        <div className="flex gap-2">
          <input id={`custom-model-${index}`} className={input} value={customDraft} maxLength={160}
            placeholder="Enter model ID"
            onChange={event => setCustomDraft(event.target.value)}
            onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); commitCustom(); } }} />
          <button type="button" className={button} disabled={!validModelId(customDraft)} onClick={commitCustom}>Set</button>
          <button type="button" className={button} onClick={() => setCustomMode(false)}>Cancel</button>
        </div>
      </div> : <label className="grid gap-1 text-xs font-medium text-slate-600">Model
        <select className={input} aria-label={`${rankLabel} model`} value={entry.model || ''} onChange={event => handleModelSelect(event.target.value)}>
          <option value="">Site default</option>
          {!inList && entry.model && <option value={entry.model}>{entry.model} (saved ID)</option>}
          {options.map(item => <option key={item.id} value={item.id}>{modelOptionLabel(entry.backend, item)}</option>)}
          <option value={CUSTOM_MODEL}>Custom model ID…</option>
        </select>
      </label>}
      {entry.backend === 'openrouter' && hasKey && <label className="grid gap-1 text-xs font-medium text-slate-600 sm:col-span-2">Upstream provider slug (optional)
        <input className={input} defaultValue={entry.provider || ''} key={`${index}-${entry.backend}-${entry.provider || ''}`} maxLength={80}
          placeholder="Auto (let OpenRouter route)"
          onBlur={event => onUpdate(index, { ...entry, provider: event.target.value.trim() })} />
      </label>}
    </div>
    {entry.model && !hasKey && <p className="pl-8 text-xs text-amber-800">Add a personal {MAP_PROVIDERS[entry.backend].name} key above to use a specific model; without one, this step uses Site configuration.</p>}
    {!entry.model && hasKey && <p className="pl-8 text-xs text-amber-800">{options.length ? 'Select a model to use your personal key.' : 'Enter a custom model ID if your model is unavailable.'}</p>}
  </li>;
}
FallbackRow.propTypes = {
  entry: PropTypes.object.isRequired,
  index: PropTypes.number.isRequired,
  total: PropTypes.number.isRequired,
  onUpdate: PropTypes.func.isRequired,
  onMove: PropTypes.func.isRequired,
  onRemove: PropTypes.func.isRequired,
  isDragging: PropTypes.bool,
  isOver: PropTypes.bool,
  onDragStart: PropTypes.func,
  onDragOver: PropTypes.func,
  onDragLeave: PropTypes.func,
  onDrop: PropTypes.func,
  onDragEnd: PropTypes.func,
};

function IntelligenceSettings() {
  const { preferences, save, keys, catalogs } = useSitesRuntime();
  const [dragIndex, setDragIndex] = useState(null);
  const dragIndexRef = useRef(null);
  const [overIndex, setOverIndex] = useState(null);
  const chain = preferences.mapChain || [{ backend: 'openrouter', model: '' }];

  function updateEntry(index, nextEntry) {
    const next = chain.map((item, i) => (i === index ? nextEntry : item));
    save({ mapChain: next });
  }

  function moveEntry(index, direction) {
    save({ mapChain: reorderList(chain, index, index + direction) });
  }

  function handleDrop(targetIndex, event) {
    const raw = dragIndexRef.current ?? dragIndex ?? Number(event?.dataTransfer?.getData('text/plain'));
    const from = Number.isInteger(raw) ? raw : null;
    if (from != null && targetIndex >= 0 && from !== targetIndex) {
      save({ mapChain: reorderList(chain, from, targetIndex) });
    }
    dragIndexRef.current = null;
    setDragIndex(null);
    setOverIndex(null);
  }

  function removeEntry(index) {
    if (chain.length <= 1) return;
    save({ mapChain: chain.filter((_, i) => i !== index) });
  }

  function addEntry() {
    if (chain.length >= MAX_MAP_ROUTES) return;
    const used = new Set(chain.map(item => `${item.backend}|${item.model}`));
    const preferredOrder = [
      ...MAP_PROVIDER_IDS.filter(id => keys[id]),
      ...MAP_PROVIDER_IDS.filter(id => !keys[id]),
    ];
    for (const backend of preferredOrder) {
      if (keys[backend]) {
        const candidate = modelsForProvider(backend, catalogs).find(item => !used.has(`${backend}|${item.id}`));
        if (candidate) { save({ mapChain: [...chain, { backend, model: candidate.id }] }); return; }
      } else if (!used.has(`${backend}|`)) {
        save({ mapChain: [...chain, { backend, model: '' }] });
        return;
      }
    }
    const fallbackBackend = preferredOrder[0];
    const fallbackModel = modelsForProvider(fallbackBackend, catalogs).find(item => !used.has(`${fallbackBackend}|${item.id}`))?.id || '';
    save({ mapChain: [...chain, { backend: fallbackBackend, model: fallbackModel }] });
  }

  return <section id="intelligence" className="scroll-mt-5 space-y-6">
    <header>
      <h3 className="text-lg font-semibold text-slate-900">Intelligence</h3>
      <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-600">
        Connect personal keys per provider, then order the models that turn transcripts into maps. You can add multiple models from the same provider.
      </p>
    </header>

    <div className="space-y-2">
      <h4 className="text-sm font-semibold text-slate-800">Provider accounts & keys</h4>
      <ul className="divide-y divide-slate-200 rounded-xl border border-slate-200 bg-white px-4">
        {MAP_PROVIDER_IDS.map(id => {
          const { name } = MAP_PROVIDERS[id];
          return <li key={id} className="py-3">
            <ProviderKeyForm backend={id} name={name} summaryName />
          </li>;
        })}
      </ul>
    </div>

    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-sm font-semibold text-slate-800">Model fallback order</h4>
        <button type="button" className={button} disabled={chain.length >= MAX_MAP_ROUTES} onClick={addEntry}>+ Add model</button>
      </div>
      {chain.some(entry => entry.backend === 'anthropic') && (
        <p className="text-xs text-slate-600">
          Claude base rates in USD per million tokens. Haiku 5.5 uses the higher rate above 100,000 input tokens.{' '}
          <a className="underline underline-offset-2" href={ANTHROPIC_PRICING_URL} target="_blank" rel="noreferrer">Anthropic pricing</a>
        </p>
      )}
      <ol className="space-y-2.5">
        {chain.map((entry, index) => <FallbackRow
          key={`${index}-${entry.backend}-${entry.model}`}
          entry={entry}
          index={index}
          total={chain.length}
          onUpdate={updateEntry}
          onMove={moveEntry}
          onRemove={removeEntry}
          isDragging={dragIndex === index}
          isOver={overIndex === index && dragIndex !== null && dragIndex !== index}
          onDragStart={event => {
            dragIndexRef.current = index;
            setDragIndex(index);
            event.dataTransfer?.setData('text/plain', String(index));
            if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
          }}
          onDragOver={event => {
            if (dragIndexRef.current === null && dragIndex === null) return;
            event.preventDefault();
            if (overIndex !== index) setOverIndex(index);
          }}
          onDragLeave={() => { if (overIndex === index) setOverIndex(null); }}
          onDrop={event => {
            event.preventDefault();
            handleDrop(index, event);
          }}
          onDragEnd={() => { dragIndexRef.current = null; setDragIndex(null); setOverIndex(null); }}
        />)}
      </ol>
    </div>
  </section>;
}

export default function SitesProviderSettings() {
  const { storageError, credentialError, credentialsReady } = useSitesRuntime();
  return <div className="max-w-3xl space-y-7">
    <header>
      <h2 className="text-xl font-semibold text-slate-900">Providers</h2>
      <p className="mt-1 text-sm leading-6 text-slate-600">Keys, model lists, and fallback order are saved in this browser.</p>
    </header>
    <nav aria-label="Provider categories" className="flex flex-wrap gap-x-4 gap-y-1 text-sm font-medium text-slate-700">
      <a className="inline-flex min-h-11 items-center underline underline-offset-4" href="#speech-to-text">Speech-to-text</a>
      <a className="inline-flex min-h-11 items-center underline underline-offset-4" href="#intelligence">Intelligence</a>
    </nav>
    {!credentialsReady && <p role="status" className="text-sm text-slate-600">Loading saved provider keys…</p>}
    {credentialError && <p role="alert" className="text-sm text-rose-800">{credentialError}</p>}
    {storageError && <p role="alert" className="text-sm text-rose-800">{storageError}</p>}
    <SpeechOrder />
    <IntelligenceSettings />
  </div>;
}
