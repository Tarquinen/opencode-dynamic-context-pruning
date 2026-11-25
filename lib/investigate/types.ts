import type { SessionState } from "../state"
import type { Logger } from "../logger"

export interface InvestigateToolContext {
    client: any
    state: SessionState
    logger: Logger
}
