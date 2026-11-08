import * as BackgroundTask from 'expo-background-task';
import * as TaskManager from 'expo-task-manager';
import { reconcileOccurrences } from './repository';

export const OCCURRENCE_RECONCILIATION_TASK = 'wayykup-occurrence-reconciliation';

TaskManager.defineTask(OCCURRENCE_RECONCILIATION_TASK, async () => {
  try {
    await reconcileOccurrences();
    return BackgroundTask.BackgroundTaskResult.Success;
  } catch (error) {
    console.error('Background alarm reconciliation failed.', error);
    return BackgroundTask.BackgroundTaskResult.Failed;
  }
});

export async function registerOccurrenceReconciliationTask(): Promise<void> {
  if (await TaskManager.isTaskRegisteredAsync(OCCURRENCE_RECONCILIATION_TASK)) return;
  if (await BackgroundTask.getStatusAsync() !== BackgroundTask.BackgroundTaskStatus.Available) return;
  await BackgroundTask.registerTaskAsync(OCCURRENCE_RECONCILIATION_TASK, { minimumInterval: 15 });
}
