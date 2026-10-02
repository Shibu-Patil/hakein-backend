import mongoose from 'mongoose';

const { Schema } = mongoose;

const UserSchema = new Schema(
  {
    email: { type: String, unique: true, required: true, index: true },
    name: String,
    avatar: String,
    provider: { type: String, default: 'email' },
    providerId: String,
    profile: { type: Schema.Types.Mixed, required: true },
    preferences: { type: Schema.Types.Mixed, required: true },
    linkedinToken: String,
    linkedinEmail: String,
    linkedinPassword: String,
    naukriEmail: String,
    naukriPassword: String,
    qaProfile: { type: Schema.Types.Mixed }
  },
  { timestamps: true }
);

const JobSchema = new Schema(
  {
    source: { type: String, required: true },
    externalId: { type: String, required: true },
    title: { type: String, required: true },
    company: { type: String, required: true },
    location: { type: String, required: true },
    url: { type: String, required: true },
    description: { type: String, required: true },
    requirements: String,
    salary: String,
    jobType: String,
    experience: String,
    postedAt: { type: Date, required: true, index: true },
    rawData: { type: Schema.Types.Mixed }
  },
  { timestamps: true }
);
JobSchema.index({ source: 1, externalId: 1 }, { unique: true });

const ApplicationSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    jobId: { type: Schema.Types.ObjectId, ref: 'Job', required: true },
    status: { type: String, default: 'pending', index: true },
    resumeUsed: { type: String, required: true },
    coverLetter: String,
    appliedAt: Date,
    response: { type: Schema.Types.Mixed },
    answersUsed: { type: Schema.Types.Mixed },
    error: String,
    retryCount: { type: Number, default: 0 }
  },
  { timestamps: true }
);
ApplicationSchema.index({ userId: 1, jobId: 1 }, { unique: true });

const ScreeningAnswerSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    questionNorm: { type: String, required: true },
    question: { type: String, required: true },
    answer: { type: String, required: true },
    source: { type: String, default: 'manual' }
  },
  { timestamps: true }
);
ScreeningAnswerSchema.index({ userId: 1, questionNorm: 1 }, { unique: true });

const PendingQuestionSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    jobId: { type: Schema.Types.ObjectId, ref: 'Job' },
    applicationId: { type: Schema.Types.ObjectId, ref: 'Application' },
    source: { type: String, default: 'linkedin' },
    question: { type: String, required: true },
    questionNorm: { type: String, required: true },
    fieldType: { type: String, default: 'text' },
    options: { type: Schema.Types.Mixed },
    status: { type: String, default: 'pending', index: true },
    answer: String,
    expiresAt: Date
  },
  { timestamps: true }
);

const ScrapingLogSchema = new Schema(
  {
    source: { type: String, required: true },
    status: { type: String, required: true },
    jobsFound: { type: Number, required: true },
    jobsNew: { type: Number, required: true },
    error: String,
    duration: { type: Number, required: true }
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

export const User = mongoose.models.User || mongoose.model('User', UserSchema);
export const Job = mongoose.models.Job || mongoose.model('Job', JobSchema);
export const Application = mongoose.models.Application || mongoose.model('Application', ApplicationSchema);
export const ScreeningAnswer =
  mongoose.models.ScreeningAnswer || mongoose.model('ScreeningAnswer', ScreeningAnswerSchema);
export const PendingQuestion =
  mongoose.models.PendingQuestion || mongoose.model('PendingQuestion', PendingQuestionSchema);
export const ScrapingLog = mongoose.models.ScrapingLog || mongoose.model('ScrapingLog', ScrapingLogSchema);
