import type { db } from '../db';
import type { DiscussionEffort } from './discussionEngine';

export type SynthesisConfig = {
  aiProviderId?: string;
  model?: string;
  prompt?: string;
  effort?: DiscussionEffort;
};

export type ParticipantInput = {
  name?: string | null;
  prompt?: string | null;
  position?: number;
  actorId?: string | null;
  aiProviderId?: string | null;
  model?: string | null;
  temperature?: number | null;
  effort?: DiscussionEffort | null;
};

export type DiscussionModel = InstanceType<(typeof db)['Discussion']> & {
  project?: InstanceType<(typeof db)['Project']>;
  aiProvider?: InstanceType<(typeof db)['AiProvider']>;
  participants?: (InstanceType<(typeof db)['DiscussionParticipant']> & {
    actor?: InstanceType<(typeof db)['Actor']> | null;
    aiProvider?: InstanceType<(typeof db)['AiProvider']> | null;
  })[];
};
