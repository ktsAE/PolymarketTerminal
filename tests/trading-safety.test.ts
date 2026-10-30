import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createTradingService, createRegistry, assertMainSender } = require('../electron/safety.cjs');
it('restricts every invoke to the current main frame',()=>{const frame={};const wc={mainFrame:frame};const win={isDestroyed:()=>false,webContents:wc};expect(()=>assertMainSender({sender:wc,senderFrame:frame},win)).not.toThrow();expect(()=>assertMainSender({sender:wc,senderFrame:{}},win)).toThrow();expect(()=>assertMainSender({sender:{},senderFrame:frame},win)).toThrow();expect(()=>assertMainSender({sender:wc,senderFrame:frame},undefined)).toThrow();});
const instrument = { assetId:'1', marketTitle:'Trusted', outcome:'Yes', tickSize:'0.01', minOrderSize:'5', acceptingOrders:true, closed:false, metadataAt:1000 };
function setup(liveEnabled=true, overrides:Record<string, unknown>={}) {
 let time=1000; const registry=createRegistry({now:()=>time}); registry.cache([instrument]); registry.subscribe(['1']); registry.event({event_type:'book',asset_id:'1',timestamp:'1000',bids:[],asks:[]});
 const client={account:{wallet:'wallet'},fetchClosedOnlyMode:vi.fn(async()=>false),placeLimitOrder:vi.fn(async()=>({ok:true,orderId:'x'})),cancelAll:vi.fn(async()=>({canceled:['x']}))};
 const service=createTradingService({registry,now:()=>time,liveEnabled,createClient:async()=>client,fetch:async()=>({ok:true,json:async()=>({blocked:false})}),...overrides});
 const draft=()=>({assetId:'1',marketTitle:'Spoof',outcome:'Spoof',side:'BUY',price:'0.50',size:'5',sizeUnit:'SHARES',execution:'GTC',mode:'DRY',requestId:'r',bookGeneration:registry.health('1').generation,tickVersion:registry.health('1').tickVersion,armEpoch:service.status().armEpoch});
 return {registry,client,service,draft,setTime:(n:number)=>{time=n;}};
}
describe('fail-closed session transitions', () => {
 it('revokes the old arm synchronously before re-arm location or restriction checks', async () => {
  const publish = vi.fn();
  const fetch = vi.fn(async () => ({ok:true,json:async()=>({blocked:false})}));
  const s = setup(true, {publish, fetch});
  await s.service.connect({});
  await s.service.arm(true);
  const oldOrder = {...s.draft(), mode:'LIVE'};
  const epoch = s.service.status().armEpoch;
  let release!: (value:any) => void;
  fetch.mockImplementationOnce(() => new Promise(resolve => {release = resolve;}));
  const pending = s.service.arm(true);
  const rejected = expect(pending).rejects.toThrow('restriction offline');
  const immediate = s.service.status();
  s.client.fetchClosedOnlyMode.mockRejectedValueOnce(Error('restriction offline'));
  release({ok:true,json:async()=>({blocked:false})});
  await rejected;
  expect(immediate).toMatchObject({armed:false,armEpoch:epoch+1});
  expect(publish.mock.calls.at(-1)?.[0]).toMatchObject({armed:false,armEpoch:epoch+1});
  await expect(s.service.submit(oldOrder)).rejects.toThrow(/epoch/i);
  expect(s.client.placeLimitOrder).not.toHaveBeenCalled();
 });

 it('blocks an in-flight LIVE order while re-arm restrictions are pending', async () => {
  const s = setup();
  await s.service.connect({});
  await s.service.arm(true);
  const epoch = s.service.status().armEpoch;
  let releaseOrder!: (value:boolean) => void;
  s.client.fetchClosedOnlyMode.mockImplementationOnce(() => new Promise(resolve => {releaseOrder=resolve;}));
  const pendingOrder = s.service.submit({...s.draft(),mode:'LIVE'});
  const rejected = expect(pendingOrder).rejects.toThrow(/epoch/i);
  await vi.waitFor(() => expect(releaseOrder).toBeTypeOf('function'));
  let releaseArm!: (value:boolean) => void;
  s.client.fetchClosedOnlyMode.mockImplementationOnce(() => new Promise(resolve => {releaseArm=resolve;}));
  const pendingArm = s.service.arm(true);
  await vi.waitFor(() => expect(releaseArm).toBeTypeOf('function'));
  const pendingStatus = s.service.status();
  releaseOrder(false);
  await rejected;
  releaseArm(false);
  await pendingArm;
  expect(pendingStatus).toMatchObject({armed:false,armEpoch:epoch+1});
  expect(s.client.placeLimitOrder).not.toHaveBeenCalled();
  expect(s.service.status()).toMatchObject({armed:true,armEpoch:epoch+2});
 });

 it.each(['close', 'create'])('publishes disconnected immediately and after %s failure', async failure => {
  const publish = vi.fn();
  const observed: any[] = [];
  const old = {
   account: {wallet:'old'},
   fetchClosedOnlyMode: vi.fn(async () => false),
   closeSubscriptions: vi.fn(async () => {
    observed.push(publish.mock.calls.at(-1)?.[0]);
    if (failure === 'close') throw Error('close failed');
   }),
  };
  const createClient = vi.fn().mockResolvedValueOnce(old).mockRejectedValue(Error('create failed'));
  const s = setup(true, {publish, createClient});
  await s.service.connect({});
  await s.service.arm(true);
  const epoch = s.service.status().armEpoch;
  await expect(s.service.connect({})).rejects.toThrow(`${failure} failed`);
  expect(observed.at(-1)).toMatchObject({connected:false,armed:false,armEpoch:epoch+1});
  expect(publish.mock.calls.at(-1)?.[0]).toMatchObject({connected:false,armed:false,armEpoch:epoch+1});
  expect(s.service.status()).toMatchObject({connected:false,armed:false});
  expect(createClient).toHaveBeenCalledTimes(failure === 'close' ? 1 : 2);
 });

 it('does not let an older connection completion replace a newer session', async () => {
  let release!: (value:any) => void;
  const old = {account:{wallet:'old'},closeSubscriptions:vi.fn()};
  const newest = {account:{wallet:'new'}};
  const createClient = vi.fn().mockImplementationOnce(() => new Promise(resolve => {release=resolve;})).mockResolvedValueOnce(newest);
  const s = setup(true, {createClient});
  const pending = s.service.connect({});
  const rejected = expect(pending).rejects.toThrow(/superseded/i);
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  await s.service.connect({});
  release(old);
  await rejected;
  expect(s.service.status()).toMatchObject({connected:true,armed:false,account:{wallet:'new'}});
  expect(old.closeSubscriptions).toHaveBeenCalledOnce();
 });

 it.each([true, null, 'throw'])('disarms and publishes on submit restriction failure %s', async restriction => {
  const publish = vi.fn();
  const s = setup(true, {publish});
  await s.service.connect({});
  await s.service.arm(true);
  const order = {...s.draft(),mode:'LIVE'};
  const epoch = s.service.status().armEpoch;
  if (restriction === 'throw') s.client.fetchClosedOnlyMode.mockRejectedValueOnce(Error('restriction offline'));
  else s.client.fetchClosedOnlyMode.mockResolvedValueOnce(restriction as any);
  await expect(s.service.submit(order)).rejects.toThrow();
  expect(s.service.status()).toMatchObject({armed:false,armEpoch:epoch+1});
  expect(publish.mock.calls.at(-1)?.[0]).toMatchObject({armed:false,armEpoch:epoch+1});
  expect(s.client.placeLimitOrder).not.toHaveBeenCalled();
 });
});

describe('provider depth fencing',()=>{
 it('rejects superseded books/deltas without reverting tick or publishing depth',()=>{
  let time=200; const published:any[]=[]; const r=createRegistry({now:()=>time,publish:(h:any)=>published.push(h)});
  r.cache([instrument]);r.subscribe(['1']);
  expect(r.event({event_type:'book',asset_id:'1',timestamp:'200',tick_size:'0.01',bids:[],asks:[]})).toBeTruthy();
  time=201;r.event({event_type:'tick_size_change',asset_id:'1',timestamp:'201',new_tick_size:'0.001'});
  const count=published.length;
  expect(r.event({event_type:'book',asset_id:'1',timestamp:'100',tick_size:'0.01',bids:[],asks:[]})).toBe(false);
  expect(r.event({event_type:'book',asset_id:'1',bids:[],asks:[]})).toBe(false);
  expect(r.health('1').initialized).toBe(false);expect(r.metadata('1').tickSize).toBe('0.001');expect(published).toHaveLength(count);
  time=202;const accepted=r.event({event_type:'book',asset_id:'1',timestamp:'202',bids:[],asks:[]});
  expect(accepted).toMatchObject({generation:r.health('1').generation,tickVersion:r.health('1').tickVersion,tick_size:'0.001'});
  expect(r.event({event_type:'price_change',timestamp:'100',price_changes:[{asset_id:'1',price:'0.5',size:'1',side:'BUY'}]})).toBe(false);
  r.unsubscribe(['1']);r.subscribe(['1']);expect(r.event({event_type:'book',asset_id:'1',timestamp:'200',bids:[],asks:[]})).toBe(false);
 });
 it('does not renew eligibility or overwrite a WS tick with Gamma cache',()=>{
  const s=setup();s.setTime(62000);s.registry.event({event_type:'tick_size_change',asset_id:'1',timestamp:'62000',new_tick_size:'0.001'});
  expect(s.registry.metadata('1').metadataAt).toBe(1000);
  s.registry.cache([instrument]);expect(s.registry.metadata('1').tickSize).toBe('0.001');
 });
 it('fences REST responses using captured generation, not provider tags',()=>{
  const s=setup();const proof=s.registry.health('1');s.registry.invalidate();
  expect(s.registry.event({event_type:'book',asset_id:'1',bids:[],asks:[]},{generation:proof.generation,tickVersion:proof.tickVersion})).toBe(false);
  const current=s.registry.health('1');expect(s.registry.event({event_type:'book',asset_id:'1',tick_size:'0.001',bids:[],asks:[]},{generation:current.generation,tickVersion:current.tickVersion})).toBeTruthy();
 });
 it('preserves the known acknowledgment even when audit persistence throws',()=>{
  const {persistAuditResult}=require('../electron/safety.cjs');const result={status:'LIVE_ACCEPTED',requestId:'exact',orderId:'x'};
  expect(persistAuditResult(result,()=>{throw Error('secret');},()=>{})).toMatchObject({...result,auditWarning:expect.any(String)});
 });
});
describe('authoritative trading',()=>{
 it('requires identity fields and uses main metadata, never a client for DRY',async()=>{const s=setup();const d=s.draft();delete (d as any).requestId;await expect(s.service.submit(d)).rejects.toThrow();const result=await s.service.submit(s.draft());expect(result.marketTitle).toBe('Trusted');expect(s.client.placeLimitOrder).not.toHaveBeenCalled();});
 it('deduplicates request and rejects changed bodies',async()=>{const s=setup();const d=s.draft();const [a,b]=await Promise.all([s.service.submit(d),s.service.submit(d)]);expect(a).toEqual(b);await expect(s.service.submit({...d,size:'6'})).rejects.toThrow(/request/i);});
 it('invalidates on disconnect/tick and ignores deltas before snapshot',()=>{const s=setup();s.registry.invalidate();s.registry.event({event_type:'price_change',price_changes:[{asset_id:'1',price:'0.5',size:'1',side:'BUY'}]});expect(s.registry.health('1').initialized).toBe(false);});
 it('caps total active assets at six atomically',()=>{const s=setup();expect(()=>s.registry.subscribe(['2','3','4','5','6','7'])).toThrow();expect(s.registry.active()).toEqual(['1']);});
 it('rejects stale live and disables live by default',async()=>{const s=setup(false);await expect(s.service.arm(true)).rejects.toThrow(/disabled/i);expect(s.service.status().liveEnabled).toBe(false);});
 it('rechecks disarm after async checks',async()=>{const s=setup();await s.service.connect({});await s.service.arm(true);const d={...s.draft(),mode:'LIVE'};let release:any; s.client.fetchClosedOnlyMode.mockImplementationOnce(()=>new Promise(r=>release=r));const pending=s.service.submit(d);await vi.waitFor(()=>expect(release).toBeTypeOf('function'));await s.service.arm(false);release(false);await expect(pending).rejects.toThrow();expect(s.client.placeLimitOrder).not.toHaveBeenCalled();});
 it('disarms before cancellation and publishes even on failure',async()=>{const s=setup();await s.service.connect({});await s.service.arm(true);s.client.cancelAll.mockImplementation(async()=>{expect(s.service.status().armed).toBe(false);throw Error('offline');});await expect(s.service.cancelAll()).rejects.toThrow('offline');expect(s.service.status().armed).toBe(false);});
 it('rejects stale LIVE books and invalidates tick snapshots',async()=>{const s=setup();await s.service.connect({});await s.service.arm(true);s.setTime(11001);await expect(s.service.submit({...s.draft(),mode:'LIVE'})).rejects.toThrow(/stale/i);s.registry.event({event_type:'tick_size_change',asset_id:'1',new_tick_size:'0.001'});expect(s.registry.health('1').initialized).toBe(false);expect(s.registry.metadata('1').tickSize).toBe('0.001');});
 it('invalid tick metadata never allows a later snapshot to reuse the old tick',async()=>{const s=setup();s.registry.event({event_type:'tick_size_change',asset_id:'1',new_tick_size:'bogus'});s.registry.event({event_type:'book',asset_id:'1',bids:[],asks:[]});await expect(s.service.submit(s.draft())).rejects.toThrow();});
 it('uses REST snapshot tick and minimum as authoritative metadata',()=>{const s=setup();const old=s.registry.health('1');s.registry.event({event_type:'book',asset_id:'1',timestamp:'1000',bids:[],asks:[],tick_size:'0.001',min_order_size:'10'});expect(s.registry.metadata('1').tickSize).toBe('0.001');expect(s.registry.metadata('1').minOrderSize).toBe('10');expect(s.registry.health('1').tickVersion).toBeGreaterThan(old.tickVersion);});
 it('rejects old generation after unsubscribe/resubscribe',async()=>{const s=setup();const d=s.draft();s.registry.unsubscribe(['1']);s.registry.subscribe(['1']);s.setTime(2000);s.registry.event({event_type:'book',asset_id:'1',timestamp:'2000',bids:[],asks:[]});await expect(s.service.submit(d)).rejects.toThrow(/generation/i);});
 it('retains UNKNOWN_SUBMISSION without retry',async()=>{const s=setup();await s.service.connect({});await s.service.arm(true);s.client.placeLimitOrder.mockRejectedValue(Error('timeout'));const d={...s.draft(),mode:'LIVE'};expect((await s.service.submit(d)).status).toBe('UNKNOWN_SUBMISSION');expect((await s.service.submit(d)).status).toBe('UNKNOWN_SUBMISSION');expect(s.client.placeLimitOrder).toHaveBeenCalledTimes(1);});
});
