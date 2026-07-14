/**
 * Local replacement for @centaur/rendering's ChatSDKStreamChunk.
 * Covers only the three variants that opentag renders.
 */

export type RendererTaskStatus = 'pending' | 'in_progress' | 'complete' | 'error'

export type ChatSDKStreamChunk =
  | { type: 'markdown_text'; text: string }
  | {
      type: 'task_update'
      id: string
      title: string
      status: RendererTaskStatus
      details?: string
      output?: string
    }
  | { type: 'plan_update'; title: string }
