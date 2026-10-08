import {existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {contentHash, contentProjection, sha256} from './content-review-contract.mjs';

export function savedContent(reviewDir, sourcePath) {
  const dir = resolve(reviewDir), store = join(dir,'workbench');
  if (existsSync(join(store,'journal.json')) || existsSync(join(store,'save.lock'))) throw Error('内容保存事务尚未完成');
  const head = JSON.parse(readFileSync(join(store,'head.json'),'utf8'));
  const source = realpathSync(sourcePath);
  if (head.version !== 'content-workbench/1' || realpathSync(head.context.files[0].path) !== source
      || head.source_hash !== sha256(readFileSync(source))) throw Error('工作台已保存版本与当前主稿不匹配');
  const draftPath = join(dir,head.context.draftPath);
  if (existsSync(draftPath)) {
    const draft = JSON.parse(readFileSync(draftPath,'utf8'));
    if (contentHash(contentProjection(draft)) !== contentHash(contentProjection(head.state))) throw Error('还有未保存主稿的草稿修改');
  }
  return {head, source};
}

export function writeContentSnapshot(reviewDir, sourcePath, dependencies = {}) {
  const {head,source} = savedContent(reviewDir,sourcePath);
  const bind = path => ({path:realpathSync(path),sha256:sha256(readFileSync(path))});
  const snapshot = {version:'content-workbench-snapshot/1',revision:head.revision,
    source:bind(source),review_kind:head.context.reviewKind,page_mapping:head.page_mapping,
    dependencies:Object.fromEntries(Object.entries(dependencies).map(([key,path]) => [key,bind(path)]))};
  const path = join(resolve(reviewDir),'workbench','exports',contentHash(snapshot)+'.json');
  mkdirSync(dirname(path),{recursive:true});
  if (!existsSync(path)) writeFileSync(path,JSON.stringify(snapshot,null,2)+'\n',{flag:'wx'});
  return path;
}
