const $ = id => document.getElementById(id);
async function refresh(){
  const s=await chrome.storage.local.get(['lastResult','lastSubmissionResult','lastDeadlineCleanup','connected','calendarId','courseOverrides','assignmentCount','coursesMissing']);
  $('calendarId').value=s.calendarId||'primary';
  $('overrides').value=JSON.stringify(s.courseOverrides||{},null,2);
  $('status').textContent=JSON.stringify({connected:!!s.connected,assignmentCount:s.assignmentCount,missingCourseIds:s.coursesMissing,lastResult:s.lastResult,lastSubmissionResult:s.lastSubmissionResult,lastDeadlineCleanup:s.lastDeadlineCleanup},null,2);
}
$('connect').onclick=async()=>{
  $('status').textContent='Google認証中...';
  const res=await chrome.runtime.sendMessage({type:'CONNECT'});
  if(!res.ok) alert(res.error);
  await refresh();
};
$('save').onclick=async()=>{
  try {
    const overrides=JSON.parse($('overrides').value);
    if(!overrides||Array.isArray(overrides)||typeof overrides!=='object'||Object.values(overrides).some(v=>typeof v!=='string')) throw Error('授業名は文字列にしてください');
    await chrome.storage.local.set({calendarId:$('calendarId').value.trim()||'primary',courseOverrides:overrides});
    alert('設定を保存しました');
  }catch(e){alert('JSONを確認してください: '+e.message);}
};
$('sync').onclick=async()=>{
  $('status').textContent='同期中...';
  const res=await chrome.runtime.sendMessage({type:'SYNC'});
  if(!res.ok) alert(res.error);
  await refresh();
};
refresh();
