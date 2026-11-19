/**
 * 派发的唯一出口：一条任务只在这里选择「唤醒」还是「落收件箱」。
 *
 * 有侧栏插件时 `onTask` 由插件提供，任务是唤醒消息里的同一份数据；
 * 没有插件时同一条任务写进本地收件箱，等人说一声再由模型读。
 * 两条路径消费同一个 `task` 对象，不各自拼一份形状 —— 模型侧不需要知道有没有插件。
 */
import { createTaskInbox } from './doc-inbox.mjs';

export const DISPATCH_CHANNELS = ['wake', 'inbox', 'none'];

/**
 * @param {{docPath:string, onTask?:Function|null, inbox?:object|false}} options
 * @returns {(task:object) => Promise<{channel:string, task_id:string, status:string, path?:string}>}
 */
export function createTaskDispatcher({ docPath, onTask = null, inbox } = {}) {
  const waking = typeof onTask === 'function';
  const store = waking || inbox === false ? null : (inbox ?? createTaskInbox(docPath));

  return async function dispatch(task) {
    if (waking) {
      await onTask(task);
      return { channel: 'wake', task_id: task.id, status: task.status };
    }
    if (!store) return { channel: 'none', task_id: task.id, status: task.status };
    const delivered = store.put(task);
    return { channel: 'inbox', task_id: task.id, status: task.status, path: delivered.path };
  };
}
