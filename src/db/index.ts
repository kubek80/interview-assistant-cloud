// The browser's data layer for the hosted version: everything comes from the server's API.
// Screens import from here and never call fetch themselves. The local app's IndexedDB layer is kept
// for reference in src/db-local/ (not built); step 2 ports the remaining screens to this layer by
// adding functions and hooks here with the same names and shapes (see README "Porting a screen").
export { ApiError, RepoError, api, qs, setSignedOutHandler } from './http';
export { queryClient, orNull } from './queryClient';
export { LiveProvider, useLiveTopics, useLiveStatus } from './live';
export { useMe, hasPermission, useAuthOptions, googleSignInHref, useDevUsers, devSignIn, signOut } from './auth';
export {
  WEIGHT_RANGE,
  useTracks,
  useTrackBank,
  useBankStatus,
  saveQuestion,
  bulkAddQuestions,
  setQuestionStatus,
  addCategory,
  updateCategory,
  removeCategory,
  newTrackProblems,
  createTrack,
  exportTrackFile,
  exportTrackCsv,
  importQuestionFiles,
} from './bank';
export type { SaveQuestionInput, CategoryInput, NewTrackInput, SaveQuestionResult, TrackBank, TrackSummary, ExportedTrack } from './bank';
export { useUsers, previewInvites, addUsers, updateUser, removeUser } from './users';
export { useAuditLog, exportAuditCsv, AUDIT_ACTION_LABELS } from './audit';
export type { AuditFilter } from './audit';
export {
  useReviewCounts,
  useProposals,
  useProposal,
  proposeChange,
  proposeNew,
  proposeMany,
  withdrawProposal,
  acceptProposal,
  declineProposal,
  useFeedback,
  addComment,
  setLooksGood,
  useReviewers,
  useReviewRequests,
  useReviewRequest,
  createReviewRequest,
  closeReviewRequest,
  useMyReviews,
  useMyReview,
  setItemDone,
} from './review';
export {
  useRounds,
  useRound,
  useRoundInterviews,
  useRoundQuestionSet,
  useQuestionSet,
  useTeamOptions,
  useRoundAudit,
  useMyInterviews,
  useInterview,
  createRound,
  updateRound,
  closeRound,
  reopenRound,
  setRoundMember,
  removeRoundMember,
  saveRoundQuestionSet,
  planInterview,
  planMany,
  changeInterview,
  cancelInterview,
} from './rounds';
