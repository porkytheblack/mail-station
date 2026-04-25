import { Brand } from "effect"

export type UserId = string & Brand.Brand<"UserId">
export type AccountId = string & Brand.Brand<"AccountId">
export type MessageId = string & Brand.Brand<"MessageId">
export type ThreadId = string & Brand.Brand<"ThreadId">
export type JobId = string & Brand.Brand<"JobId">

export const UserId = Brand.nominal<UserId>()
export const AccountId = Brand.nominal<AccountId>()
export const MessageId = Brand.nominal<MessageId>()
export const ThreadId = Brand.nominal<ThreadId>()
export const JobId = Brand.nominal<JobId>()

export const newAccountId = (): AccountId => AccountId(crypto.randomUUID())
