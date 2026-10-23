package animalinterface;

/** (3) 实现 Animal 接口的狗类 */
public class Dog implements Animal {
    @Override
    public void cry() {
        System.out.println("汪汪汪！");
    }

    @Override
    public String getAnimalName() {
        return "狗";
    }
}
