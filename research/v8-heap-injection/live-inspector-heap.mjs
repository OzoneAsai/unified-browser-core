import inspector from 'node:inspector';
import assert from 'node:assert/strict';
globalThis.synthetic = (()=>{
  let hiddenCounter=8;
  const object={stage:'before', nested:{value:1}};
  return {object, advance:()=>++hiddenCounter};
})();
const session=new inspector.Session();session.connect();
const send=(method,params={})=>new Promise((resolve,reject)=>session.post(method,params,(err,data)=>err?reject(err):resolve(data)));
try {
  await send('Runtime.enable');
  await send('HeapProfiler.enable');
  await send('HeapProfiler.startTrackingHeapObjects',{trackAllocations:false});
  const first=await send('Runtime.evaluate',{expression:'globalThis.synthetic.object'});
  assert.ok(first.result.objectId);
  const heap=await send('HeapProfiler.getHeapObjectId',{objectId:first.result.objectId});
  assert.ok(heap.heapSnapshotObjectId);
  // Drop the debugger handle; the application itself still holds the object.
  await send('Runtime.releaseObject',{objectId:first.result.objectId});
  const reacquired=await send('HeapProfiler.getObjectByHeapObjectId',{objectId:heap.heapSnapshotObjectId});
  assert.ok(reacquired.result.objectId);
  const mutation=await send('Runtime.callFunctionOn',{
    objectId:reacquired.result.objectId,
    functionDeclaration:'function(value){this.stage="after";this.nested.value=value;return {stage:this.stage,nested:this.nested.value};}',
    arguments:[{value:73}],returnByValue:true
  });
  assert.deepEqual(mutation.result.value,{stage:'after',nested:73});
  assert.equal(globalThis.synthetic.object.nested.value,73);
  assert.equal(globalThis.synthetic.advance(),9);
  console.log(JSON.stringify({heapObjectIdAvailable:true,reacquiredAfterReleaseWithTracking:true,mutatedLiveObject:true,closureNotAffected:true,object:mutation.result.value}));
} finally {session.disconnect()}
