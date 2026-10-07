import * as Sentry from '@sentry/node';
import {telemetryOptions} from '../../shared/telemetry/privacy.mjs';
Sentry.init(telemetryOptions(process.env,process.argv[2]==='worker'?'worker':'room'));
export {Sentry};
