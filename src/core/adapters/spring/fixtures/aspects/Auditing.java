package app;

@Aspect
public class Auditing {
  @Pointcut("execution(* app.*.save(..))")
  void changes() {}

  @AfterReturning("changes()")
  void audit() {}
}
