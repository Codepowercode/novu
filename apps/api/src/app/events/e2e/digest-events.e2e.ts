import {
  MessageRepository,
  NotificationTemplateEntity,
  SubscriberEntity,
  JobRepository,
  JobStatusEnum,
} from '@novu/dal';
import { StepTypeEnum, DigestTypeEnum, DigestUnitEnum } from '@novu/shared';
import { UserSession, SubscribersService } from '@novu/testing';
import axios from 'axios';
import { expect } from 'chai';
import { getTime, parseISO } from 'date-fns';
import mongoose from 'mongoose';
import { setTimeout } from 'timers/promises';

import { WorkflowQueueService } from '../services/workflow-queue/workflow.queue.service';
import { SendMessage } from '../usecases/send-message/send-message.usecase';
import { QueueNextJob } from '../usecases/queue-next-job/queue-next-job.usecase';
import { StorageHelperService } from '../services/storage-helper-service/storage-helper.service';
import { RunJob } from '../usecases/run-job/run-job.usecase';
import { RunJobCommand } from '../usecases/run-job/run-job.command';

const axiosInstance = axios.create();

describe('Trigger event - Digest triggered events - /v1/events/trigger (POST)', function () {
  let session: UserSession;
  let template: NotificationTemplateEntity;
  let subscriber: SubscriberEntity;
  let subscriberService: SubscribersService;
  const jobRepository = new JobRepository();
  let workflowQueueService: WorkflowQueueService;
  const messageRepository = new MessageRepository();
  let runJob: RunJob;

  const triggerEvent = async (payload, transactionId?: string): Promise<void> => {
    await axiosInstance.post(
      `${session.serverUrl}/v1/events/trigger`,
      {
        transactionId,
        name: template.triggers[0].identifier,
        to: [subscriber.subscriberId],
        payload,
      },
      {
        headers: {
          authorization: `ApiKey ${session.apiKey}`,
        },
      }
    );
  };

  beforeEach(async () => {
    session = new UserSession();
    await session.initialize();
    template = await session.createTemplate();
    subscriberService = new SubscribersService(session.organization._id, session.environment._id);
    subscriber = await subscriberService.createSubscriber();
    workflowQueueService = session.testServer?.getService(WorkflowQueueService);

    runJob = new RunJob(
      jobRepository,
      session.testServer?.getService(SendMessage),
      session.testServer?.getService(QueueNextJob),
      session.testServer?.getService(StorageHelperService)
    );
  });

  it('should digest events within time interval', async function () {
    template = await session.createTemplate({
      steps: [
        {
          type: StepTypeEnum.SMS,
          content: 'Hello world {{customVar}}' as string,
        },
        {
          type: StepTypeEnum.DIGEST,
          content: '',
          metadata: {
            unit: DigestUnitEnum.MINUTES,
            amount: 5,
            type: DigestTypeEnum.REGULAR,
          },
        },
        {
          type: StepTypeEnum.SMS,
          content: 'Hello world {{customVar}}' as string,
        },
      ],
    });

    await triggerEvent({
      customVar: 'Testing of User Name',
    });

    await triggerEvent({
      customVar: 'digest',
    });

    await session.awaitRunningJobs(template?._id, false, 2);

    const initialJobs = await jobRepository.find({
      _environmentId: session.environment._id,
      _templateId: template._id,
      type: StepTypeEnum.DIGEST,
    });

    expect(initialJobs.length).to.eql(2);

    const delayedJobs = initialJobs.filter((elem) => elem.status === JobStatusEnum.DELAYED);
    expect(delayedJobs.length).to.eql(1);
    const mergedJobs = initialJobs.filter((elem) => elem.status !== JobStatusEnum.DELAYED);
    expect(mergedJobs.length).to.eql(1);

    const delayedJob = delayedJobs[0];

    expect(delayedJob).to.be.ok;

    await runJob.execute(
      RunJobCommand.create({
        jobId: delayedJob._id,
        environmentId: delayedJob._environmentId,
        organizationId: delayedJob._organizationId,
        userId: delayedJob._userId,
      })
    );

    const jobs = await jobRepository.find({
      _environmentId: session.environment._id,
      _templateId: template._id,
      status: {
        $nin: [JobStatusEnum.CANCELED],
      },
    });

    const digestJob = jobs.find((job) => job.step?.template?.type === StepTypeEnum.DIGEST);
    expect(digestJob?.digest?.amount).to.equal(5);
    expect(digestJob?.digest?.unit).to.equal(DigestUnitEnum.MINUTES);
    const job = jobs.find((item) => item.digest?.events?.length && item.digest.events.length > 0);
    expect(job?.digest?.events?.length).to.equal(2);
  });

  it('should not have digest prop when not running a digest', async function () {
    template = await session.createTemplate({
      steps: [
        {
          type: StepTypeEnum.SMS,
          content: 'Hello world {{#if step.digest}} HAS_DIGEST_PROP {{else}} NO_DIGEST_PROP {{/if}}' as string,
        },
      ],
    });

    await triggerEvent({
      customVar: 'Testing of User Name',
    });

    await session.awaitRunningJobs(template?._id, false, 0);

    const message = await messageRepository.find({
      _environmentId: session.environment._id,
      _subscriberId: subscriber._id,
      channel: StepTypeEnum.SMS,
    });

    expect(message[0].content).to.include('NO_DIGEST_PROP');
    expect(message[0].content).to.not.include('HAS_DIGEST_PROP');
  });

  it('should add a digest prop to template compilation', async function () {
    template = await session.createTemplate({
      steps: [
        {
          type: StepTypeEnum.DIGEST,
          content: '',
          metadata: {
            unit: DigestUnitEnum.MINUTES,
            amount: 5,
            type: DigestTypeEnum.REGULAR,
          },
        },
        {
          type: StepTypeEnum.SMS,
          content: 'Hello world {{#if step.digest}} HAS_DIGEST_PROP {{/if}}' as string,
        },
      ],
    });

    await triggerEvent({
      customVar: 'Testing of User Name',
    });

    await session.awaitRunningJobs(template?._id, false, 2);

    await triggerEvent({
      customVar: 'digest',
    });

    await session.awaitRunningJobs(template?._id, false, 2);

    const jobs = await jobRepository.find({
      _environmentId: session.environment._id,
      _templateId: template._id,
      type: StepTypeEnum.DIGEST,
    });

    expect(jobs.length).to.eql(2);

    const delayedJobs = jobs.filter((elem) => elem.status === JobStatusEnum.DELAYED);
    expect(delayedJobs.length).to.eql(1);
    const mergedJobs = jobs.filter((elem) => elem.status !== JobStatusEnum.DELAYED);
    expect(mergedJobs.length).to.eql(1);

    const delayedJob = delayedJobs[0];

    await runJob.execute(
      RunJobCommand.create({
        jobId: delayedJob._id,
        environmentId: delayedJob._environmentId,
        organizationId: delayedJob._organizationId,
        userId: delayedJob._userId,
      })
    );

    await session.awaitRunningJobs(template?._id, false, 1);

    const message = await messageRepository.find({
      _environmentId: session.environment._id,
      _subscriberId: subscriber._id,
      channel: StepTypeEnum.SMS,
    });

    expect(message[0].content).to.include('HAS_DIGEST_PROP');
  });

  it('should digest based on digestKey within time interval', async function () {
    const id = MessageRepository.createObjectId();
    template = await session.createTemplate({
      steps: [
        {
          type: StepTypeEnum.SMS,
          content: 'Hello world {{customVar}}' as string,
        },
        {
          type: StepTypeEnum.DIGEST,
          content: '',
          metadata: {
            unit: DigestUnitEnum.MINUTES,
            amount: 5,
            digestKey: 'id',
            type: DigestTypeEnum.REGULAR,
          },
        },
        {
          type: StepTypeEnum.SMS,
          content: 'Hello world {{customVar}}' as string,
        },
      ],
    });

    await triggerEvent({
      customVar: 'Testing of User Name',
      id,
    });

    await triggerEvent({
      customVar: 'digest',
    });

    await triggerEvent({
      customVar: 'haj',
      id,
    });

    await session.awaitRunningJobs(template?._id, false, 3);

    const jobs = await jobRepository.find({
      _environmentId: session.environment._id,
      _templateId: template._id,
      type: StepTypeEnum.DIGEST,
    });

    expect(jobs.length).to.eql(3);

    const delayedJobs = jobs.filter((elem) => elem.status === JobStatusEnum.DELAYED);
    expect(delayedJobs.length).to.eql(1);
    const mergedJobs = jobs.filter((elem) => elem.status !== JobStatusEnum.DELAYED);
    expect(mergedJobs.length).to.eql(2);

    const delayedJob = delayedJobs[0];

    await runJob.execute(
      RunJobCommand.create({
        jobId: delayedJob._id,
        environmentId: delayedJob._environmentId,
        organizationId: delayedJob._organizationId,
        userId: delayedJob._userId,
      })
    );

    const finalJobs = await jobRepository.find({
      _environmentId: session.environment._id,
      _templateId: template._id,
    });
    const digestJob = finalJobs.find((job) => job?.digest?.digestKey === 'id');
    expect(digestJob).not.be.undefined;
    const jobsWithEvents = finalJobs.filter((item) => item?.digest?.events && item.digest.events.length > 0);
    expect(jobsWithEvents.length).to.equal(1);
  });

  it('should digest based on same digestKey within time interval', async function () {
    const firstDigestKey = MessageRepository.createObjectId();
    const secondDigestKey = MessageRepository.createObjectId();
    template = await session.createTemplate({
      steps: [
        {
          type: StepTypeEnum.DIGEST,
          content: '',
          metadata: {
            unit: DigestUnitEnum.MINUTES,
            amount: 5,
            digestKey: 'id',
            type: DigestTypeEnum.REGULAR,
          },
        },
        {
          type: StepTypeEnum.SMS,
          content: 'Hello world {{step.events.length}}' as string,
        },
      ],
    });

    await triggerEvent({
      customVar: 'Testing of User Name',
      id: firstDigestKey,
    });

    await session.awaitRunningJobs(template?._id, false, 1);

    await triggerEvent({
      customVar: 'Testing of User Name',
      id: firstDigestKey,
    });

    await triggerEvent({
      customVar: 'digest',
      id: secondDigestKey,
    });
    await session.awaitRunningJobs(template?._id, false, 3);

    const jobs = await jobRepository.find({
      _environmentId: session.environment._id,
      _templateId: template._id,
      type: StepTypeEnum.DIGEST,
    });

    expect(jobs.length).to.equal(3);

    // TODO: Fix this as it is not creating 2 delayed jobs, one per digest key, and just one job merged
    const delayedJobs = jobs.filter((elem) => elem.status === JobStatusEnum.DELAYED);
    expect(delayedJobs.length).to.eql(1);
    const mergedJobs = jobs.filter((elem) => elem.status !== JobStatusEnum.DELAYED);
    expect(mergedJobs.length).to.eql(2);

    for (const job of jobs) {
      await runJob.execute(
        RunJobCommand.create({
          jobId: job._id,
          environmentId: job._environmentId,
          organizationId: job._organizationId,
          userId: job._userId,
        })
      );
    }

    await session.awaitRunningJobs(template?._id, false, 0);

    const messages = await messageRepository.find({
      _environmentId: session.environment._id,
      _subscriberId: subscriber._id,
      channel: StepTypeEnum.SMS,
    });

    const firstDigestKeyBatch = messages.filter((message) => (message.content as string).includes('Hello world 2'));
    const secondDigestKeyBatch = messages.filter((message) => (message.content as string).includes('Hello world 1'));

    expect(firstDigestKeyBatch.length).to.eql(2);
    expect(secondDigestKeyBatch.length).to.eql(1);

    expect(messages.length).to.equal(3);
  });

  it('should digest delayed events', async function () {
    template = await session.createTemplate({
      steps: [
        {
          type: StepTypeEnum.IN_APP,
          content: 'Hello world {{customVar}}' as string,
        },
        {
          type: StepTypeEnum.DIGEST,
          content: '',
          metadata: {
            unit: DigestUnitEnum.SECONDS,
            amount: 1,
            type: DigestTypeEnum.REGULAR,
          },
        },
        {
          type: StepTypeEnum.IN_APP,
          content: 'Hello world {{step.events.length}}' as string,
        },
      ],
    });

    await triggerEvent({
      customVar: 'Testing of User Name',
    });

    await session.awaitRunningJobs(template?._id, false, 0);

    const jobs = await jobRepository.find({
      _environmentId: session.environment._id,
      _templateId: template._id,
      status: {
        $ne: JobStatusEnum.COMPLETED,
      },
    });

    expect(jobs.length).to.equal(0);
  });

  it('should be able to cancel digest', async function () {
    const id = MessageRepository.createObjectId();
    template = await session.createTemplate({
      steps: [
        {
          type: StepTypeEnum.IN_APP,
          content: 'Hello world {{customVar}}' as string,
        },
        {
          type: StepTypeEnum.DIGEST,
          content: '',
          metadata: {
            unit: DigestUnitEnum.MINUTES,
            amount: 5,
            digestKey: 'id',
            type: DigestTypeEnum.REGULAR,
          },
        },
        {
          type: StepTypeEnum.IN_APP,
          content: 'Hello world {{step.events.length}}' as string,
        },
      ],
    });

    await triggerEvent(
      {
        customVar: 'Testing of User Name',
      },
      id
    );

    await session.awaitRunningJobs(template?._id, false, 1);
    await axiosInstance.delete(`${session.serverUrl}/v1/events/trigger/${id}`, {
      headers: {
        authorization: `ApiKey ${session.apiKey}`,
      },
    });

    const delayedJobs = await jobRepository.find({
      _environmentId: session.environment._id,
      _templateId: template._id,
      type: StepTypeEnum.DIGEST,
    });

    expect(delayedJobs.length).to.eql(1);

    const delayedJob = delayedJobs[0];

    await runJob.execute(
      RunJobCommand.create({
        jobId: delayedJob._id,
        environmentId: delayedJob._environmentId,
        organizationId: delayedJob._organizationId,
        userId: delayedJob._userId,
      })
    );

    const pendingJobs = await jobRepository.count({
      _environmentId: session.environment._id,
      _templateId: template._id,
      status: JobStatusEnum.PENDING,
      transactionId: id,
    });

    expect(pendingJobs).to.equal(1);

    const cancelledDigestJobs = await jobRepository.find({
      _environmentId: session.environment._id,
      _templateId: template._id,
      status: JobStatusEnum.CANCELED,
      type: StepTypeEnum.DIGEST,
      transactionId: id,
    });

    expect(cancelledDigestJobs.length).to.eql(1);
  });

  xit('should be able to update existing message on the in-app digest', async function () {
    const id = MessageRepository.createObjectId();
    template = await session.createTemplate({
      steps: [
        {
          type: StepTypeEnum.DIGEST,
          content: '',
          metadata: {
            unit: DigestUnitEnum.MINUTES,
            amount: 5,
            updateMode: true,
            type: DigestTypeEnum.REGULAR,
          },
        },
        {
          type: StepTypeEnum.IN_APP,
          content: 'Hello world {{step.events.length}}' as string,
        },
        {
          type: StepTypeEnum.SMS,
          content: 'Hello world {{step.events.length}}' as string,
        },
      ],
    });

    await triggerEvent(
      {
        customVar: 'Testing of User Name',
      },
      id
    );
    await session.awaitRunningJobs(template?._id, false, 1);

    const oldMessage = await messageRepository.findOne({
      _environmentId: session.environment._id,
      channel: StepTypeEnum.IN_APP,
      _templateId: template._id,
      _subscriberId: subscriber._id,
    });

    await triggerEvent({
      customVar: 'Testing of User Name',
    });

    const delayedJobs = await jobRepository.find({
      _environmentId: session.environment._id,
      _templateId: template._id,
      type: StepTypeEnum.DIGEST,
      transactionId: id,
    });

    expect(delayedJobs.length).to.eql(1);

    const delayedJob = delayedJobs[0];

    await runJob.execute(
      RunJobCommand.create({
        jobId: delayedJob._id,
        environmentId: delayedJob._environmentId,
        organizationId: delayedJob._organizationId,
        userId: delayedJob._userId,
      })
    );

    await session.awaitRunningJobs(template?._id, false, 0);

    const message = await messageRepository.findOne({
      _environmentId: session.environment._id,
      channel: StepTypeEnum.IN_APP,
      _templateId: template._id,
    });

    expect(oldMessage.content).to.equal('Hello world 0');
    expect(message.content).to.equal('Hello world 2');
  });

  it('should digest with backoff strategy', async function () {
    template = await session.createTemplate({
      steps: [
        {
          type: StepTypeEnum.DIGEST,
          content: '',
          metadata: {
            unit: DigestUnitEnum.MINUTES,
            amount: 5,
            type: DigestTypeEnum.BACKOFF,
            backoffUnit: DigestUnitEnum.MINUTES,
            backoffAmount: 5,
          },
        },
        {
          type: StepTypeEnum.IN_APP,
          content: 'Hello world {{step.events.length}}' as string,
        },
      ],
    });

    await triggerEvent({
      customVar: 'Testing of User Name',
    });

    await session.awaitRunningJobs(template?._id, false, 0);

    await triggerEvent({
      customVar: 'digest',
    });

    await session.awaitRunningJobs(template?._id, false, 1);

    const delayedJobs = await jobRepository.find({
      _environmentId: session.environment._id,
      _templateId: template._id,
      type: StepTypeEnum.DIGEST,
    });

    expect(delayedJobs.length).to.eql(1);

    const delayedJob = delayedJobs[0];

    const pendingJobs = await jobRepository.find({
      _environmentId: session.environment._id,
      _templateId: template._id,
      status: {
        $nin: [JobStatusEnum.COMPLETED, JobStatusEnum.DELAYED, JobStatusEnum.CANCELED],
      },
    });

    expect(pendingJobs.length).to.equal(1);
    const pendingJob = pendingJobs[0];

    await runJob.execute(
      RunJobCommand.create({
        jobId: delayedJob._id,
        environmentId: delayedJob._environmentId,
        organizationId: delayedJob._organizationId,
        userId: delayedJob._userId,
      })
    );
    await session.awaitRunningJobs(template?._id, false, 0);
    const job = await jobRepository.findById(pendingJob._id);

    expect(job?.digest?.events?.length).to.equal(1);
    expect(job?.digest?.events?.[0].customVar).to.equal('digest');
  });

  xit('should digest with backoff strategy and update mode', async function () {
    template = await session.createTemplate({
      steps: [
        {
          type: StepTypeEnum.DIGEST,
          content: '',
          metadata: {
            unit: DigestUnitEnum.SECONDS,
            amount: 30,
            type: DigestTypeEnum.BACKOFF,
            backoffUnit: DigestUnitEnum.SECONDS,
            backoffAmount: 10,
            updateMode: true,
          },
        },
        {
          type: StepTypeEnum.IN_APP,
          content: 'Hello world {{step.events.length}}' as string,
        },
      ],
    });

    await triggerEvent({
      customVar: 'first',
    });

    await session.awaitRunningJobs(template?._id, false, 0);

    await triggerEvent({
      customVar: 'second',
    });

    await session.awaitRunningJobs(template?._id, false, 0);

    let messageCount = await messageRepository.find({
      _environmentId: session.environment._id,
      _templateId: template._id,
    });

    expect(messageCount.length).to.equal(2);

    await triggerEvent({
      customVar: 'third',
    });

    await session.awaitRunningJobs(template?._id, false, 1);
    const delayedJob = await jobRepository.findOne({
      _environmentId: session.environment._id,
      _templateId: template._id,
      type: StepTypeEnum.DIGEST,
    });

    await runJob.execute(
      RunJobCommand.create({
        jobId: delayedJob._id,
        environmentId: delayedJob._environmentId,
        organizationId: delayedJob._organizationId,
        userId: delayedJob._userId,
      })
    );

    await session.awaitRunningJobs(template?._id, false, 0);

    messageCount = await messageRepository.find({
      _environmentId: session.environment._id,
      _templateId: template._id,
      _subscriberId: subscriber._id,
    });

    expect(messageCount.length).to.equal(2);
    const job = await jobRepository.findOne({
      _environmentId: session.environment._id,
      _templateId: template._id,
      type: StepTypeEnum.IN_APP,
      transactionId: delayedJob.transactionId,
    });

    expect(job?.digest?.events?.[0].customVar).to.equal('second');
    expect(job?.digest?.events?.[1].customVar).to.equal('third');
  });

  xit('should digest with regular strategy and update mode', async function () {
    template = await session.createTemplate({
      steps: [
        {
          type: StepTypeEnum.DIGEST,
          content: '',
          metadata: {
            unit: DigestUnitEnum.SECONDS,
            amount: 30,
            type: DigestTypeEnum.REGULAR,
            updateMode: true,
          },
        },
        {
          type: StepTypeEnum.IN_APP,
          content: 'Hello world {{step.events.length}}' as string,
        },
      ],
    });

    await triggerEvent({
      customVar: 'first',
    });

    await triggerEvent({
      customVar: 'second',
    });

    await triggerEvent({
      customVar: 'third',
    });

    await session.awaitRunningJobs(template?._id, false, 0);
    const delayedJob = await jobRepository.findOne({
      _environmentId: session.environment._id,
      _templateId: template._id,
      type: StepTypeEnum.DIGEST,
    });

    await runJob.execute(
      RunJobCommand.create({
        jobId: delayedJob._id,
        environmentId: delayedJob._environmentId,
        organizationId: delayedJob._organizationId,
        userId: delayedJob._userId,
      })
    );

    await session.awaitRunningJobs(template?._id, false, 0);

    const messageCount = await messageRepository.find({
      _environmentId: session.environment._id,
      _templateId: template._id,
      _subscriberId: subscriber._id,
    });

    expect(messageCount.length).to.equal(1);
    const job = await jobRepository.findOne({
      _environmentId: session.environment._id,
      _templateId: template._id,
      type: StepTypeEnum.IN_APP,
      transactionId: delayedJob.transactionId,
    });

    expect(job?.digest?.events?.length).to.equal(3);
  });

  it('should create multiple digest based on different digestKeys', async function () {
    const postId = MessageRepository.createObjectId();
    template = await session.createTemplate({
      steps: [
        {
          type: StepTypeEnum.DIGEST,
          content: '',
          metadata: {
            unit: DigestUnitEnum.MINUTES,
            amount: 5,
            digestKey: 'postId',
            type: DigestTypeEnum.REGULAR,
          },
        },
        {
          type: StepTypeEnum.SMS,
          content: 'Hello world {{postId}}' as string,
        },
      ],
    });

    await triggerEvent({
      customVar: 'Testing of User Name',
      postId,
    });

    await triggerEvent({
      customVar: 'digest',
      postId: MessageRepository.createObjectId(),
    });

    await session.awaitRunningJobs(template?._id, false, 2);

    let digests = await jobRepository.find({
      _environmentId: session.environment._id,
      _templateId: template._id,
      type: StepTypeEnum.DIGEST,
    });

    expect(digests[0].payload.postId).not.to.equal(digests[1].payload.postId);
    expect(digests.length).to.equal(2);

    digests = await jobRepository.find({
      _environmentId: session.environment._id,
      _templateId: template._id,
      type: StepTypeEnum.DIGEST,
    });

    for (const digest of digests) {
      await runJob.execute(
        RunJobCommand.create({
          jobId: digest._id,
          environmentId: digest._environmentId,
          organizationId: digest._organizationId,
          userId: digest._userId,
        })
      );
    }

    await session.awaitRunningJobs(template?._id, false, 0);

    const messages = await messageRepository.find({
      _environmentId: session.environment._id,
      _templateId: template._id,
      _subscriberId: subscriber._id,
    });

    expect(messages[0].content).to.include(digests[0].payload.postId);
    expect(messages[1].content).to.include(digests[1].payload.postId);
    const jobCount = await jobRepository.count({
      _environmentId: session.environment._id,
      _templateId: template._id,
    });
    expect(jobCount).to.equal(6);
  });

  it('should create multiple digest based on different digestKeys with backoff', async function () {
    const postId = MessageRepository.createObjectId();
    const postId2 = MessageRepository.createObjectId();
    template = await session.createTemplate({
      steps: [
        {
          type: StepTypeEnum.DIGEST,
          content: '',
          metadata: {
            unit: DigestUnitEnum.MINUTES,
            amount: 5,
            digestKey: 'postId',
            type: DigestTypeEnum.BACKOFF,
            backoffUnit: DigestUnitEnum.MINUTES,
            backoffAmount: 5,
          },
        },
        {
          type: StepTypeEnum.SMS,
          content: 'Hello world {{postId}}' as string,
        },
      ],
    });

    await triggerEvent({
      customVar: 'first',
      postId,
    });
    await session.awaitParsingEvents();

    await triggerEvent({
      customVar: 'fourth',
      postId,
    });

    await session.awaitParsingEvents();

    await triggerEvent({
      customVar: 'second',
      postId: postId2,
    });

    await session.awaitParsingEvents();

    await triggerEvent({
      customVar: 'third',
      postId: postId2,
    });

    await session.awaitRunningJobs(template?._id, false, 2);

    const digests = await jobRepository.find({
      _environmentId: session.environment._id,
      _templateId: template._id,
      type: StepTypeEnum.DIGEST,
    });

    expect(digests.length).to.equal(2);
    expect(digests[0].payload.postId).not.to.equal(digests[1].payload.postId);

    for (const digest of digests) {
      await runJob.execute(
        RunJobCommand.create({
          jobId: digest._id,
          environmentId: digest._environmentId,
          organizationId: digest._organizationId,
          userId: digest._userId,
        })
      );
    }

    await session.awaitRunningJobs(template?._id, false, 0);

    const messages = await messageRepository.find({
      _environmentId: session.environment._id,
      _templateId: template._id,
      _subscriberId: subscriber._id,
    });

    expect(messages.length).to.equal(4);

    const contents: string[] = messages
      .map((message) => message.content)
      .reduce((prev, content: string) => {
        if (prev.includes(content)) {
          return prev;
        }
        prev.push(content);

        return prev;
      }, [] as string[]);

    expect(contents).to.include(`Hello world ${postId}`);
    expect(contents).to.include(`Hello world ${postId2}`);

    const jobCount = await jobRepository.count({
      _environmentId: session.environment._id,
      _templateId: template._id,
    });

    expect(jobCount).to.equal(10);
  });

  it('should add a digest prop to chat template compilation', async function () {
    template = await session.createTemplate({
      steps: [
        {
          type: StepTypeEnum.DIGEST,
          content: '',
          metadata: {
            unit: DigestUnitEnum.MINUTES,
            amount: 5,
            type: DigestTypeEnum.REGULAR,
          },
        },
        {
          type: StepTypeEnum.CHAT,
          content: 'Hello world {{#if step.digest}} HAS_DIGEST_PROP {{/if}}' as string,
        },
      ],
    });

    await triggerEvent({
      customVar: 'Testing of User Name',
    });

    await session.awaitRunningJobs(template?._id, false, 1);

    await triggerEvent({
      customVar: 'digest',
    });

    await session.awaitRunningJobs(template?._id, false, 2);

    const jobs = await jobRepository.find({
      _environmentId: session.environment._id,
      _templateId: template._id,
      type: StepTypeEnum.DIGEST,
    });

    expect(jobs.length).to.eql(2);

    const delayedJobs = jobs.filter((elem) => elem.status === JobStatusEnum.DELAYED);
    expect(delayedJobs.length).to.eql(1);
    const mergedJobs = jobs.filter((elem) => elem.status !== JobStatusEnum.DELAYED);
    expect(mergedJobs.length).to.eql(1);

    const delayedJob = delayedJobs[0];

    await runJob.execute(
      RunJobCommand.create({
        jobId: delayedJob._id,
        environmentId: delayedJob._environmentId,
        organizationId: delayedJob._organizationId,
        userId: delayedJob._userId,
      })
    );

    await session.awaitRunningJobs(template?._id, false, 1);

    const message = await messageRepository.find({
      _environmentId: session.environment._id,
      _subscriberId: subscriber._id,
      channel: StepTypeEnum.CHAT,
    });

    expect(message[0].content).to.include('HAS_DIGEST_PROP');
  });

  it('should add a digest prop to push template compilation', async function () {
    template = await session.createTemplate({
      steps: [
        {
          type: StepTypeEnum.DIGEST,
          content: '',
          metadata: {
            unit: DigestUnitEnum.MINUTES,
            amount: 5,
            type: DigestTypeEnum.REGULAR,
          },
        },
        {
          type: StepTypeEnum.PUSH,
          title: 'Hello world {{#if step.digest}} HAS_DIGEST_PROP {{/if}}',
          content: 'Hello world {{#if step.digest}} HAS_DIGEST_PROP {{/if}}' as string,
        },
      ],
    });

    await triggerEvent({
      customVar: 'Testing of User Name',
    });

    await session.awaitRunningJobs(template?._id, false, 1);

    await triggerEvent({
      customVar: 'digest',
    });

    await session.awaitRunningJobs(template?._id, false, 2);

    const jobs = await jobRepository.find({
      _environmentId: session.environment._id,
      _templateId: template._id,
      type: StepTypeEnum.DIGEST,
    });

    const delayedJobs = jobs.filter((elem) => elem.status === JobStatusEnum.DELAYED);
    expect(delayedJobs.length).to.eql(1);
    const mergedJobs = jobs.filter((elem) => elem.status !== JobStatusEnum.DELAYED);
    expect(mergedJobs.length).to.eql(1);

    const delayedJob = delayedJobs[0];

    await runJob.execute(
      RunJobCommand.create({
        jobId: delayedJob._id,
        environmentId: delayedJob._environmentId,
        organizationId: delayedJob._organizationId,
        userId: delayedJob._userId,
      })
    );

    await session.awaitRunningJobs(template?._id, false, 1);

    const message = await messageRepository.find({
      _environmentId: session.environment._id,
      _subscriberId: subscriber._id,
      channel: StepTypeEnum.PUSH,
    });

    expect(message[0].content).to.include('HAS_DIGEST_PROP');
  });

  it('should merge digest events accordingly when concurrent calls', async () => {
    template = await session.createTemplate({
      steps: [
        {
          type: StepTypeEnum.DIGEST,
          content: '',
          metadata: {
            unit: DigestUnitEnum.MINUTES,
            amount: 5,
            type: DigestTypeEnum.REGULAR,
          },
        },
        {
          type: StepTypeEnum.IN_APP,
          content: 'Hello world {{step.events.length}}' as string,
        },
      ],
    });

    const result = await Promise.all([
      triggerEvent({
        customVar: 'concurrent-call-1',
      }),
      triggerEvent({
        customVar: 'concurrent-call-2',
      }),
      triggerEvent({
        customVar: 'concurrent-call-3',
      }),
      triggerEvent({
        customVar: 'concurrent-call-4',
      }),
      triggerEvent({
        customVar: 'concurrent-call-5',
      }),
      triggerEvent({
        customVar: 'concurrent-call-6',
      }),
      triggerEvent({
        customVar: 'concurrent-call-7',
      }),
      triggerEvent({
        customVar: 'concurrent-call-8',
      }),
      triggerEvent({
        customVar: 'concurrent-call-9',
      }),
      triggerEvent({
        customVar: 'concurrent-call-10',
      }),
    ]);

    await session.awaitRunningJobs(template?._id, false, 10);

    const jobs = await jobRepository.find({
      _environmentId: session.environment._id,
      _templateId: template._id,
      type: StepTypeEnum.DIGEST,
    });

    expect(jobs.length).to.eql(10);

    const delayedJobs = jobs.filter((elem) => elem.status === JobStatusEnum.DELAYED);
    expect(delayedJobs.length).to.eql(1);
    const mergedJobs = jobs.filter((elem) => elem.status !== JobStatusEnum.DELAYED);
    expect(mergedJobs.length).to.eql(9);

    const delayedJobUpdateTime = delayedJobs[0].updatedAt;
    expect(delayedJobUpdateTime).to.be.ok;

    /*
     * As the only one digest job delayed, because it is updated after creation, its update time has to be greater than the other jobs
     * that have been skipped to delay and therefore merged
     */
    for (const mergedJob of mergedJobs) {
      expect(getTime(parseISO(delayedJobUpdateTime))).to.greaterThan(getTime(parseISO(mergedJob.updatedAt)));
    }
  });

  it('should merge digest events accordingly when sequential calls', async () => {
    template = await session.createTemplate({
      steps: [
        {
          type: StepTypeEnum.DIGEST,
          content: '',
          metadata: {
            unit: DigestUnitEnum.MINUTES,
            amount: 5,
            type: DigestTypeEnum.REGULAR,
          },
        },
        {
          type: StepTypeEnum.IN_APP,
          content: 'Hello world {{step.events.length}}' as string,
        },
      ],
    });

    await triggerEvent({ customVar: 'sequential-calls-1' });
    await triggerEvent({ customVar: 'sequential-calls-2' });
    await triggerEvent({ customVar: 'sequential-calls-3' });
    await triggerEvent({ customVar: 'sequential-calls-4' });
    await triggerEvent({ customVar: 'sequential-calls-5' });
    await triggerEvent({ customVar: 'sequential-calls-6' });
    await triggerEvent({ customVar: 'sequential-calls-7' });
    await triggerEvent({ customVar: 'sequential-calls-8' });
    await triggerEvent({ customVar: 'sequential-calls-9' });
    await triggerEvent({ customVar: 'sequential-calls-10' });

    await session.awaitRunningJobs(template?._id, false, 10);

    const jobs = await jobRepository.find({
      _environmentId: session.environment._id,
      _templateId: template._id,
      type: StepTypeEnum.DIGEST,
    });

    expect(jobs.length).to.eql(10);

    const delayedJobs = jobs.filter((elem) => elem.status === JobStatusEnum.DELAYED);
    expect(delayedJobs.length).to.eql(1);
    const mergedJobs = jobs.filter((elem) => elem.status !== JobStatusEnum.DELAYED);
    expect(mergedJobs.length).to.eql(9);

    const delayedJob = delayedJobs[0];
    const { updatedAt: delayedJobUpdateTime, payload } = delayedJob;
    expect(delayedJobUpdateTime).to.be.ok;
    expect(payload).to.eql({ customVar: 'sequential-calls-1' });
  });
});
