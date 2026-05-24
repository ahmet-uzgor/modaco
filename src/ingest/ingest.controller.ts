import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { ZodValidationPipe } from '../shared/zod-validation.pipe';
import {
  StartIngestSchema,
  type IngestBatchPresented,
  type StartIngestDto,
} from './ingest.dto';
import { IngestService } from './ingest.service';

@Controller('ingest/batches')
export class IngestController {
  constructor(private readonly service: IngestService) {}

  /**
   * Plan §7 / §8: register and kick off a vendor batch. 202 Accepted because
   * the actual splitting and processing happen on JobRunner — the response
   * just confirms the batch row exists. Re-POSTing the same
   * (vendorId, sourceFile) is idempotent and returns the existing batch.
   */
  @Post()
  @HttpCode(202)
  start(
    @Body(new ZodValidationPipe(StartIngestSchema)) body: StartIngestDto,
  ): Promise<IngestBatchPresented> {
    return this.service.startBatch(body);
  }

  @Get(':id')
  get(@Param('id', new ParseUUIDPipe()) id: string): Promise<IngestBatchPresented> {
    return this.service.getBatch(id);
  }
}
