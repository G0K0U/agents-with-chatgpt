import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import cp from 'node:child_process';
import { QuantaClient } from '../src/telemetry/quanta.js';
import { evaluatePoolWindows, evaluateRoute } from '../src/telemetry/routing.js';
import { AntigravityBackend } from '../src/execution/antigravity.js';
import { saveExecutionOutput, listExecutionOutputs } from '../src/execution/output.js';
const dirs: string[] = [];
const temp = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c2c-r4-')); dirs.push(dir); return dir; };
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); for (const dir of dirs.splice(0)) fs.rmSync(dir, {recursive:true,force:true}); });
const w = (remaining: number | null, status = remaining === null ? 'unknown' : 'known'): any => ({label:'fixture', status, remaining_percent:remaining, used_percent:remaining === null ? null : 100-remaining,reset_at:null,resets_at_iso:null});
const client = () => Object.create(QuantaClient.prototype) as any;
describe('R4 offline safety fixtures', () => {
  it.each(['unknown','unavailable',undefined])('preserves critical with %s sibling', status => {
    const sibling = status ? w(null,status) : undefined;
    expect(evaluatePoolWindows(w(5),sibling,true)).toMatchObject({health:'critical',isCriticalOrExhausted:true,isExhausted:false});
    expect(evaluatePoolWindows(w(80),sibling,true).health).toBe('unknown');
    expect(evaluatePoolWindows(w(0),sibling,true).isExhausted).toBe(true);
  });
  it('not applicable never invents quota and unavailable blocks', () => {
    expect(evaluatePoolWindows(w(null,'not_applicable'),w(null,'not_applicable'),true).effectiveRemaining).toBeNull();
    const report = client().normalize({},'fixture');
    expect(evaluateRoute(report,{task_type:'coding',preferred_provider:'codex'})).toMatchObject({decision:'blocked',recommended_model:null});
  });
  it.each([720,10080])('retains exhausted secondary with long primary %s', minutes => {
    const account = client().normalizeCodex({accounts:[{is_current:true,primary_window_minutes:minutes,primary_used_percent:10,secondary_used_percent:99}]}).current_account;
    expect(account.constraints).toHaveLength(2);
    expect(account.constraints[1]).toMatchObject({label:'Secondary Window',remaining_percent:1});
    expect(evaluatePoolWindows(account.five_hour_window,account.weekly_window,true,account.constraints)).toMatchObject({health:'critical',effectiveRemaining:1});
    if (minutes === 720) expect(account.weekly_window.remaining_percent).toBeNull();
  });
  it.each([undefined, new Date(Date.now()-120000).toISOString()])('missing or stale sample remains UNKNOWN', observed_at => {
    const report=client().normalize({observed_at,generated_at:Date.now(),codex:{accounts:[{is_current:true,primary_used_percent:10,secondary_used_percent:10}]}},'fixture');
    expect(report.freshness).toBe('unknown');
    expect(report.providers.codex.current_account.constraints[0].remaining_percent).toBeNull();
    expect(evaluateRoute(report,{task_type:'coding'}).decision).toBe('blocked');
  });
  it('preserves fresh observation separately from fetch time', () => {
    const observed_at=new Date(Date.now()-1000).toISOString();
    const report=client().normalize({observed_at},'fixture');
    expect(report.observed_at).toBe(observed_at); expect(report.fetched_at).not.toBe(observed_at); expect(report.freshness).toBe('fresh');
  });
  it.each(['Set-Content fixture.txt x','set-content -Path fixture.txt -Value x','node -e "require(\'fs\').writeFileSync(\'fixture.txt\',\'x\')"','cmd /c echo x > fixture.txt'])('denies read-only before any spawn: %s', async instruction => {
    const root=temp(); const spy=vi.spyOn(cp,'spawn').mockImplementation(() => {throw new Error('must not spawn');});
    const backend=new AntigravityBackend({stateDir:root,executablePath:'inert'});
    const config=vi.spyOn(backend,'setupIsolatedConfig');
    const result=await backend.execute({taskId:'c2c_fixture',workspaceId:'fixture',workspaceRoot:root,instruction,writeScope:[],writableRoots:[],networkRequested:false,networkEffective:false,fullAccess:true,runTests:false,timeoutMs:1000});
    expect(result.error?.code).toBe('READ_ONLY_UNSUPPORTED'); expect(spy).not.toHaveBeenCalled(); expect(config).not.toHaveBeenCalled();
  });
  it('rejects narrow scope before spawn', async () => {
    const root=temp(), sub=path.join(root,'sub'); fs.mkdirSync(sub);
    const spy=vi.spyOn(cp,'spawn').mockImplementation(() => {throw new Error('must not spawn');});
    const result=await new AntigravityBackend({stateDir:root,executablePath:'inert'}).execute({taskId:'fixture',workspaceId:'fixture',workspaceRoot:root,instruction:'fixture',writeScope:['sub'],writableRoots:[sub],networkRequested:false,networkEffective:false,fullAccess:true,runTests:false,timeoutMs:1000});
    expect(result.error?.code).toBe('WRITE_SCOPE_UNSUPPORTED'); expect(spy).not.toHaveBeenCalled();
  });
  it.each(['example.com','localhost','127.0.0.2','127.0.0.1.evil','user@127.0.0.1'])('rejects non-allowlisted host %s before request',async host => {
    const spy=vi.spyOn(http,'request'); await expect(client().fetchRaw(host,8765,'fixture')).rejects.toThrow('QUANTA_ENDPOINT_UNSUPPORTED'); expect(spy).not.toHaveBeenCalled();
  });
  it.each(['redirect','oversize','invalid','error','timeout'])('bounds mocked transport %s without sockets',async kind => {
    vi.useFakeTimers(); const req:any=new EventEmitter(); req.destroy=vi.fn(); req.end=vi.fn();
    const res:any=new EventEmitter(); res.destroy=vi.fn(); res.statusCode=kind==='redirect'?302:200;
    let callback:any; const spy=vi.spyOn(http,'request').mockImplementation(((_opts:any, cb:any)=>{callback=cb;return req;}) as any);
    const pending=client().fetchRaw('127.0.0.1',8765,'fixture'); const assertion=expect(pending).rejects.toThrow(/^QUANTA_/); callback(res);
    if(kind==='oversize') res.emit('data',Buffer.alloc(262145));
    if(kind==='invalid'){res.emit('data','private raw invalid payload');res.emit('end');}
    if(kind==='error') req.emit('error',new Error('private raw error'));
    if(kind==='timeout') await vi.advanceTimersByTimeAsync(4001);
    await assertion; expect(spy).toHaveBeenCalledTimes(1);
  });
  it('keeps completion, failed checks, correction and independent acceptance receipts distinct', () => {
    const root=temp();
    for(const [command,exitCode] of [['execution completion',null],['vitest intermediate',1],['vitest corrected',0],['independent acceptance',null]] as const) saveExecutionOutput('fixture',{command,exitCode,raw:'{"exitCode":0,"status":"passed"}',taskId:'fixture'},root);
    const records=listExecutionOutputs('fixture',40,root);
    expect(records.map(r=>r.exitCode).sort()).toEqual([null,null,0,1].sort());
    expect(records.find(r=>r.command==='vitest intermediate')?.exitCode).toBe(1);
  });
});
