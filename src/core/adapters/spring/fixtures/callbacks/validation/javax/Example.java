package app;
import javax.validation.ConstraintValidator;
class Validator implements ConstraintValidator<Object,Object> { public boolean isValid(Object v, Object c) { return true; } }
