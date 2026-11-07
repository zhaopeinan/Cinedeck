const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { prepareAndEnqueueExplainExport, getExplainExportJob, pumpExplainExportQueue, initExplainExportQueue } = require('/app/dist/services/explainExportQueue');
const { ExplainJobService } = require('/app/dist/services/explainJobService');
const { MoocJobService } = require('/app/dist/services/moocJobService');
const { ProjectService } = require('/app/dist/services/projectService');
const { VideoComposerService } = require('/app/dist/services/videoComposer');
const { attachAvatarsToExplainInserts } = require('/app/dist/services/moocExplainAvatar');
const { markExplainMediaQc } = require('/app/dist/services/explainInsertRepair');
const { assertExplainAnimationMp4Ok, assertSpeechAudioOk } = require('/app/dist/utils/mediaQuality');

function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }
async function waitUntil(pred, timeoutMs, intervalMs=2500){
  const start=Date.now();
  while(Date.now()-start < timeoutMs){
    if(await pred()) return;
    await sleep(intervalMs);
  }
  throw new Error('等待超时');
}

(async () => {
  const moocId = process.argv[2] || 'c8195d38-b95e-4507-ad0d-3317f8104c6d';
  const forceAll = process.argv.includes('--all');
  const forceIds = new Set(
    process.argv.filter(a => /^[0-9a-f-]{36}$/i.test(a))
  );
  const db = new Database('/data/ppt_audio.db');
  const explainJobs = new ExplainJobService(db);
  initExplainExportQueue(explainJobs);
  const moocJobs = new MoocJobService(db);
  const projectService = new ProjectService(db);
  const videoComposer = new VideoComposerService(db, projectService);

  const mooc = moocJobs.getJob(moocId);
  if (!mooc) throw new Error('mooc missing');
  {
    let cfgBusy = {};
    try { cfgBusy = JSON.parse(mooc.config_json || '{}'); } catch {}
    if (mooc.status === 'queued') throw new Error('mooc busy: queued');
    if (mooc.status === 'running' && !cfgBusy.repairInProgress) throw new Error('mooc busy: running');
  }
  const cfg = moocJobs.parseConfig(mooc);
  try {
    moocJobs.markRepairInProgress(moocId, mooc.user_id, {
      kind: 'batch_reexport',
      message: '正在批量重导知识点插片（导出/叠数字人），完成后自动重合成片',
    });
  } catch (e) { console.warn('markRepair', e && e.message); }
  const kids = db.prepare('SELECT * FROM explain_jobs WHERE batch_id=? ORDER BY created_at').all(cfg.explainBatchId);
  const project = projectService.getProject(mooc.project_id);
  const projectDir = path.dirname(project.file_path);
  const quality = (['720p','1080p','1440p'].includes(String(cfg.explainExportQuality)) ? cfg.explainExportQuality : '1440p');
  const insertsPath = path.join(projectDir, 'explain_inserts.json');
  const rawInserts = JSON.parse(fs.readFileSync(insertsPath, 'utf8'));
  const byId = new Map((rawInserts.inserts||[]).map(c => [c.explainJobId, c]));

  const alreadyGood = new Set(['2f0fb40d-d95b-4e07-bb79-97d470dd635f']); // Linux fixed earlier
  const targets = [];
  for (const child of kids) {
    if (forceIds.size && !forceIds.has(child.id) && !forceAll) continue;
    if (!forceAll && !forceIds.size && alreadyGood.has(child.id)) {
      console.log('skip known-good', child.id.slice(0,8));
      continue;
    }
    const finalDir = child.final_path ? path.dirname(child.final_path) : null;
    const exportPath = finalDir ? path.join(finalDir, `export_${quality}.mp4`) : null;
    const rec = finalDir ? path.join(finalDir, 'index.record.html') : null;
    const recText = rec && fs.existsSync(rec) ? fs.readFileSync(rec, 'utf8') : '';
    const hasNewBridge = recText.includes('curTime = s') || (recText.includes('currentTime = s') && recText.includes('typeof DUR'));
    const exportOk = exportPath && fs.existsSync(exportPath) && fs.statSync(exportPath).size > 5_000_000;
    const exportMtime = exportOk ? fs.statSync(exportPath).mtimeMs : 0;
    // Force when: explicit, no fat export, or record bridge incomplete relative to this fix
    if (forceAll || forceIds.has(child.id) || !exportOk || !hasNewBridge || exportMtime < Date.now() - 0 /* always redo non-good */) {
      if (!alreadyGood.has(child.id) || forceAll || forceIds.has(child.id)) targets.push(child);
    }
  }
  // Default: all except known-good
  if (!forceIds.size && !forceAll) {
    targets.length = 0;
    for (const child of kids) if (!alreadyGood.has(child.id)) targets.push(child);
  }
  console.log('targets', targets.map(t=>t.id.slice(0,8)+':'+t.name.slice(0,24)).join(' | '));

  for (let i = 0; i < targets.length; i++) {
    const child = targets[i];
    console.log(`\n==== [${i+1}/${targets.length}] ${child.name} ====`);
    if (!child.final_path || !fs.existsSync(child.final_path)) { console.log('skip no final'); continue; }
    const finalDir = path.dirname(child.final_path);
    for (const q of ['720p','1080p','1440p']) {
      const f = path.join(finalDir, `export_${q}.mp4`);
      try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch {}
    }
    // wipe stale avatar cache for this child so force rebuild
    const avDir = path.join(projectDir, 'explain_avatars');
    if (fs.existsSync(avDir)) {
      for (const f of fs.readdirSync(avDir)) {
        if (f.includes(child.id)) {
          try { fs.unlinkSync(path.join(avDir, f)); console.log('removed', f); } catch {}
        }
      }
    }
    explainJobs.updateJob(child.id, { video_path: null, message: `批量重导 ${i+1}/${targets.length}…` });

    const exportJob = await prepareAndEnqueueExplainExport({
      explainJobs, explainJobId: child.id, userId: mooc.user_id, quality,
    });
    pumpExplainExportQueue();
    await waitUntil(() => {
      const ej = getExplainExportJob(exportJob.id);
      return !!ej && (ej.status === 'completed' || ej.status === 'failed' || ej.status === 'cancelled');
    }, 3*60*60*1000, 3000);

    const ej = getExplainExportJob(exportJob.id);
    const outPath = path.join(finalDir, `export_${quality}.mp4`);
    const videoPath = (ej?.status === 'completed' && fs.existsSync(outPath)) ? outPath
      : (explainJobs.getJob(child.id)?.video_path || null);
    if (!videoPath || !fs.existsSync(videoPath)) {
      console.log('EXPORT FAIL', ej?.status, ej?.error || ej?.message);
      markExplainMediaQc(explainJobs, child.id, { ok:false, reason: String(ej?.error || '导出失败').slice(0,300) });
      continue;
    }
    const audioPath = path.join(finalDir, 'narration.wav');
    try {
      if (fs.existsSync(audioPath)) await assertSpeechAudioOk({ filePath: audioPath, minDurationSec: 0.8 });
      await assertExplainAnimationMp4Ok({ filePath: videoPath });
    } catch (e) {
      console.log('QC FAIL', e.message);
      markExplainMediaQc(explainJobs, child.id, { ok:false, reason: e.message, path: videoPath });
      continue;
    }
    markExplainMediaQc(explainJobs, child.id, { ok:true, reason:'ok', path: videoPath });
    explainJobs.updateJob(child.id, { video_path: videoPath, message: '批量重导质检通过' });
    console.log('export ok size', fs.statSync(videoPath).size);

    const prev = byId.get(child.id) || {};
    let clip = {
      afterPage: Number(prev.afterPage) || 0,
      videoPath,
      title: child.name,
      explainJobId: child.id,
      audioPath: fs.existsSync(audioPath) ? audioPath : null,
    };
    if (cfg.enableAvatar) {
      const av = await attachAvatarsToExplainInserts({
        projectId: mooc.project_id, userId: mooc.user_id, projectDir,
        inserts: [clip], projectService, videoComposer, db,
        chromaSimilarity: cfg.chromaSimilarity ?? 0.28,
        isCancelled: () => false, force: true,
        onProgress: (m,p) => console.log('avatar', p, m),
      });
      if (av.inserts?.[0]) clip = av.inserts[0];
      console.log('avatar', av.avatarApplied, fs.statSync(clip.videoPath).size);
    }
    byId.set(child.id, clip);
    const next = [...byId.values()].sort((a,b)=>a.afterPage-b.afterPage || String(a.title).localeCompare(String(b.title)));
    fs.writeFileSync(insertsPath, JSON.stringify({
      summary: `已插入 ${next.length} 段知识点动画（批量重导 ${i+1}/${targets.length}）`,
      inserts: next, updatedAt: new Date().toISOString(),
    }, null, 2));
  }

  const next = [...byId.values()].sort((a,b)=>a.afterPage-b.afterPage || String(a.title).localeCompare(String(b.title)));
  fs.writeFileSync(insertsPath, JSON.stringify({
    summary: `已插入 ${next.length} 段知识点动画（批量重导完成）`,
    inserts: next, updatedAt: new Date().toISOString(),
  }, null, 2));
  const queued = moocJobs.queueRecomposeOnly(moocId, mooc.user_id, {
    message: '知识点插片批量重导完成，排队重合成',
  });
  // queueRecomposeOnly schedules an async wake; also poke localhost explicitly and wait briefly.
  let wakeOk = false;
  try {
    const wakeRes = await fetch('http://127.0.0.1:3001/api/internal/mooc/wake', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'batch_reexport_done' }),
    });
    wakeOk = wakeRes.ok;
    console.log('wake', wakeRes.status, await wakeRes.text());
  } catch (e) {
    console.warn('wake failed', e && e.message);
  }
  fs.writeFileSync(path.join(projectDir, 'batch_reexport_done.json'), JSON.stringify({
    at: new Date().toISOString(), queued: !!queued, wakeOk,
    targets: targets.map(t=>t.id),
  }, null, 2));
  console.log('recompose queued', !!queued, 'wake', wakeOk, 'DONE');
})().catch(e => { console.error(e); process.exit(1); });
