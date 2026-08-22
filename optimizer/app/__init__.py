"""Optimizer / AI microservice for the railway block planning system (SIH 26027).

Owns the three things that have no good equivalent in the Node ecosystem
(PRD 10.3):
  * CP-SAT constraint solving for block scheduling
  * the predictive asset-risk model
  * LLM-grounded explanation of solver decisions

The Express API is the only client; it never runs OR-Tools itself.
"""

__version__ = "0.1.0"
