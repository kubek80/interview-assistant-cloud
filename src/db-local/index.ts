// Public data-layer API for screens. Screens call these; they never write to `db` directly.
export { db, SETTINGS } from './db';
export { RepoError, newId } from './util';
export { initDatabase, getInterviewerName, setInterviewerName } from './init';
export {
  bundledSeeds,
  compareVersions,
  loadSeeds,
  importTrackFile,
  checkTrackFile,
  exportTrackFile,
  exportTrackCsv,
  pendingSeedUpdates,
  replaceWithBundledSeed,
} from './bank';
export type { SeedLoadResult, PendingSeedUpdate, TrackFileCheck, ExportedTrack } from './bank';
export { saveQuestion, bulkAddQuestions, setQuestionStatus, addCategory, updateCategory, removeCategory, createTrack, newTrackProblems, WEIGHT_RANGE } from './bankEditor';
export type { SaveQuestionInput, SaveQuestionResult, CategoryInput, NewTrackInput } from './bankEditor';
export {
  createPlan,
  updatePlanDraft,
  lockPlan,
  createSessionFromPlan,
  continueDraft,
  createDraftInterview,
  drawDraft,
  discardInterview,
  duplicatePlan,
  deletePlanDraft,
  saveCandidateDraft,
  getCandidateDraft,
} from './plans';
export type { PlanDraftPatch, NewSessionInput, CandidateDraftInput, NewInterviewOptions, DrawOptions } from './plans';
export {
  getDefaultRetentionDays,
  setDefaultRetentionDays,
  getLastTrackId,
  setLastTrackId,
  useDefaultRetentionDays,
  useLastTrackId,
  getRecordingNoticeDefault,
  useRecordingNoticeDefault,
  getIndependentScoring,
  setIndependentScoring,
  useIndependentScoring,
  MIN_RETENTION_DAYS,
  MAX_RETENTION_DAYS,
} from './settings';
export {
  confirmConsent,
  startSession,
  pauseSession,
  resumeSession,
  goToQuestion,
  stepQuestion,
  nextQuestion,
  previousQuestion,
  updateAnswer,
  setScore,
  toggleKeyPoint,
  toggleRedFlag,
  setProbeHandled,
  toggleFlag,
  skipQuestion,
  skipRemaining,
  unskipQuestion,
  addNote,
  addNoteEntry,
  editNote,
  deleteNote,
  addInterviewer,
  removeInterviewer,
  sessionElapsedSec,
  setOverall,
  submitSession,
  amendAnswer,
  amendOverall,
  deleteDraftSession,
} from './sessions';
export type { AnswerPatch, AmendAnswerPatch } from './sessions';
export { exportPlanFile, exportSessionFile, exportScorecard, exportAuditCsv, importPlanFile, importSessionFile } from './transfer';
export type { ExportedFile, SessionImportResult } from './transfer';
export { saveForLater, changePlanned, cancelPlanned, exportInvitations, importInvitationFile, planSeveral } from './planned';
export type { InvitationImportItem, InvitationImportResult, InvitationOutcome, PlanSeveralInput } from './planned';
export { importAnyFile, kindOf, IMPORT_KINDS } from './importAny';
export {
  amendEnteredJudgement,
  enterJudgement,
  enteredJudgementInput,
  loadCandidatePanel,
  loadRound,
  memberAnswers,
  panelRecordFor,
  recordDecision,
  resolvePanel,
  saveWrittenSummary,
} from './decisions';
export type { CandidatePanel, ResolvedPanel } from './decisions';
export { exportPanelFile, importPanelFile, takeTheirs } from './panelFiles';
export type { PanelExportOptions, PanelImportItem, PanelImportResult, PartOutcome } from './panelFiles';
export { exportRoundReport } from './roundReport';
export type { ImportedFileResult } from './importAny';
export { queryAudit, AUDIT_ACTION_LABELS } from './audit';
export type { AuditFilter } from './audit';
export { purgeExpired, exportCandidateData, deleteCandidateData, eraseAllData, redactAuditForSessions } from './privacy';
export { buildPanel, isBlinded, panelRecords, loadPanel, loadPlanChoices, loadComparison, panelAiEntries } from './panels';
export type { PanelEntry, PanelView, PlanChoice, ComparisonRow, PanelAiEntry } from './panels';
export {
  RECORDING_WARN_BYTES,
  attachRecording,
  attachTranscript,
  confirmRecordingNotice,
  exportRecording,
  getAiSettings,
  getAiView,
  getRecording,
  getTranscript,
  isMediaType,
  recordAiRunFailed,
  recordingNoticeGiven,
  recordingsFor,
  removeRecording,
  removeTranscript,
  saveAiResult,
  setAiEnabled,
  useAiSecondOpinion,
  useAiSettings,
  useRecording,
  useRecordingsFor,
  useTranscript,
} from './attachments';
export type { AiSettings, AiView, RecordingInput, TranscriptRecord, RecordingRecord, AiResultRecord } from './attachments';
export * from './hooks';
