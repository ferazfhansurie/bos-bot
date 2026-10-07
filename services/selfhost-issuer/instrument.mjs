import * as Sentry from '@sentry/node';
import {telemetryOptions} from '../../shared/telemetry/privacy.mjs';
Sentry.init(telemetryOptions(process.env,'issuer'));
export {Sentry};
