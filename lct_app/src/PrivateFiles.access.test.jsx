// @vitest-environment jsdom
// Test intent: tests/intent/sites-inference-choice.md. Synthetic cloud readiness only.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('./contexts/ByokContext.jsx', () => ({ ByokProvider: ({children}) => children }));
vi.mock('./contexts/UploadContext', () => ({ UploadProvider: ({children}) => children }));
vi.mock('./components/upload/UploadToast', () => ({ default: () => null }));
import App from './App';
let root, host;
const json=(value,status=200)=>({ok:status<400,status,json:async()=>value});
beforeEach(()=>{
 globalThis.IS_REACT_ACT_ENVIRONMENT=true;vi.stubEnv('VITE_SITES_MODE','true');localStorage.clear();
 // A previously dismissed floating panel must not hide the inline account controls.
 localStorage.setItem('lct.sites_access_dismissed.v1','true');
 vi.stubGlobal('fetch',vi.fn(async path=>{
  if(path==='/api/auth/session')return json({authenticated:false},401);
  if(path==='/api/auth/config')return json({google:{enabled:true,configured:true,client_id:'synthetic.apps.googleusercontent.com'}});
  if(path==='/api/cloud/files/status')return json({enabled:true,configured:true,visibility:'private',limits:{maxFileBytes:2097152}});
  if(path==='/api/cloud/files')return json({code:'sign_in',error:'Sign in'},401);
  throw new Error('Unexpected request: '+path);
 }));
 host=document.createElement('div');document.body.appendChild(host);root=createRoot(host);
});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();window.history.replaceState({},'', '/');vi.unstubAllGlobals();vi.unstubAllEnvs();localStorage.clear();});
describe('Private-files sign-in placement through real Sites routes',()=>{
 it.each(['/private-files','/private-files/','/private-files#site-access'])('shows one inline Google option at %s',async path=>{
  window.history.replaceState({},'',path);await act(async()=>root.render(<App/>));
  const panels=host.querySelectorAll('#site-access');expect(panels).toHaveLength(1);
  expect(panels[0].closest('main')).not.toBeNull();
  expect(panels[0].textContent).toContain('Your account');
  expect([...panels[0].querySelectorAll('button')].some(x=>x.textContent==='Sign in with Google')).toBe(true);
  const prompt=host.querySelector('a[href="#site-access"]');expect(prompt).not.toBeNull();
  expect(panels[0].compareDocumentPosition(prompt)&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  await act(async()=>prompt.click());expect(document.activeElement).toBe(panels[0]);
  expect(fetch.mock.calls.filter(([p])=>p==='/api/auth/config')).toHaveLength(1);
  expect(fetch.mock.calls.every(([,options])=>!options?.method||options.method==='GET')).toBe(true);
 });
});
