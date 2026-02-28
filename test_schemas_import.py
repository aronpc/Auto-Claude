# Mock pydantic for testing schema imports
import sys
from types import ModuleType

class MockBaseModel:
    class Config:
        pass

def MockField(*args, **kwargs):
    return None

# Create mock pydantic module
pydantic_mock = ModuleType('pydantic')
pydantic_mock.BaseModel = MockBaseModel
pydantic_mock.Field = MockField
sys.modules['pydantic'] = pydantic_mock

# Test the import
sys.path.insert(0, 'apps/backend')
from schemas.translation import RoadmapTranslation, IdeaTranslation, ChangelogTranslation, SpecTranslation
print('OK')
