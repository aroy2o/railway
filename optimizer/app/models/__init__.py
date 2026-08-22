"""Pydantic request/response models - the validated API boundary.

Every optimizer endpoint takes and returns a declared model, so malformed input
from the Express layer is rejected at the edge with a 422 rather than reaching
the solver.
"""
